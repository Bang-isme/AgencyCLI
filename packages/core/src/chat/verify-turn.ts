import { execa } from "execa";
import { runChatTurnWithStream, type ChatStreamInput, type ChatStreamHandlers } from "./stream.js";
import { runChatTurn, type ChatTurnInput } from "./orchestrator.js";
import { runVerifyLoop } from "../task/verify-loop.js";
import { buildAcceptanceCommandsStrict } from "../utils/package-manager.js";
import { snapshotWorkspace, workspaceChangedSince } from "../utils/workspace-snapshot.js";
import { getRuntimeFlags } from "../runtime/flags.js";
import { EventBus } from "../events/event-bus.js";

type ChatTurnResult = Awaited<ReturnType<typeof runChatTurnWithStream>>;

const HEAL_SUFFIX =
  "\n\n[Your previous changes did not pass verification. Fix the following errors and re-apply the corrected edits:]\n";

/** Run a project's acceptance commands; first non-zero exit fails with its output. */
async function runAcceptance(
  projectRoot: string,
  commands: string[][]
): Promise<{ passed: boolean; failures: string }> {
  for (const cmd of commands) {
    const [bin, ...args] = cmd;
    if (!bin) continue;
    const res = await execa(bin, args, { cwd: projectRoot, reject: false });
    if (res.exitCode !== 0) {
      return {
        passed: false,
        failures: (res.stderr || res.stdout || `${cmd.join(" ")} exited ${res.exitCode}`) as string,
      };
    }
  }
  return { passed: true, failures: "" };
}

/**
 * Engine-agnostic main-turn verify→self-correct core. `runTurn` performs one
 * turn for the given (possibly heal-suffixed) input — the streaming and the
 * non-streaming entry points below differ ONLY in which engine they pass here,
 * so the loop logic isn't duplicated.
 *
 * The production verify loop only wrapped subagent dispatches; a direct "fix
 * this" on the main turn never self-corrected. This closes that gap for the
 * one-shot CLI (the interactive TUI is intentionally NOT wired — re-running a
 * turn 3× under the user mid-conversation is a separate UX decision; `--json` is
 * also left un-verified so machine consumers get a single deterministic result).
 *
 * Off (flags) → a single turn, byte-identical to calling the engine directly.
 * On → after the turn, if it actually edited files AND the project defines real
 * acceptance scripts (build/lint/test), run them; on failure feed the errors back
 * and re-run, up to `verifyMaxRounds`. A Q&A turn, a no-edit turn, or a project
 * with no acceptance scripts short-circuits to a single turn. Never throws on a
 * still-failing result — returns the best (last) attempt so the user sees it.
 */
async function verifyAndHeal(
  input: ChatTurnInput,
  runTurn: (input: ChatTurnInput) => Promise<ChatTurnResult>
): Promise<ChatTurnResult> {
  const flags = getRuntimeFlags();
  if (!flags.verifyLoop || !flags.verifyMainTurn) {
    return runTurn(input);
  }

  const before = snapshotWorkspace(input.projectRoot);
  let last: ChatTurnResult | undefined;

  const loop = await runVerifyLoop(
    async (ctx) => {
      const prompt = ctx.round === 1 ? input.prompt : input.prompt + HEAL_SUFFIX + (ctx.previousFailures ?? "");
      if (ctx.round > 1) {
        void EventBus.getInstance().publish("chat:self-healing", { round: ctx.round });
      }
      last = await runTurn({ ...input, prompt });
    },
    async () => {
      // Nothing meaningful to verify → accept (loop ends after this round).
      if (!last || last.routeOnly) return { passed: true, failures: "" };
      if (!workspaceChangedSince(input.projectRoot, before)) return { passed: true, failures: "" };
      const acceptance = buildAcceptanceCommandsStrict(input.projectRoot, {
        lint: flags.verifyLint,
        test: flags.verifyTests,
      });
      if (acceptance.length === 0) return { passed: true, failures: "" };
      return runAcceptance(input.projectRoot, acceptance);
    },
    { maxRounds: Math.max(1, flags.verifyMaxRounds) }
  );

  if (!loop.success && loop.history.length > 0) {
    const lastVerify = loop.history[loop.history.length - 1]!.verify;
    if (!lastVerify.passed) {
      void EventBus.getInstance().publish("chat:verify-failed", {
        rounds: loop.rounds,
        reason: loop.stopReason,
        failures: lastVerify.failures.slice(0, 2000),
      });
    }
  }

  return last ?? runTurn(input);
}

/** Streaming one-shot CLI (`agency chat --stream`). Byte-identical to
 *  `runChatTurnWithStream` when the verify flags are off. */
export async function runChatTurnWithVerify(
  input: ChatStreamInput,
  handlers: ChatStreamHandlers
): Promise<ChatTurnResult> {
  return verifyAndHeal(input, (turnInput) => runChatTurnWithStream(turnInput, handlers));
}

/** Non-streaming one-shot CLI (the default human `agency chat`). Byte-identical
 *  to `runChatTurn` when the verify flags are off. (`--json` should call
 *  `runChatTurn` directly — machine consumers don't want self-heal re-runs.) */
export async function runChatTurnWithVerifyResult(
  input: ChatTurnInput
): Promise<ChatTurnResult> {
  return verifyAndHeal(input, runChatTurn);
}
