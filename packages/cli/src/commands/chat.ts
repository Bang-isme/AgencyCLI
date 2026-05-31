import { Command } from "commander";
import {
  formatChatTurnForSurface,
  formatSuggestionsOnly,
  getWorkspaceRoot,
  resolveSkillsRoot,
  runChatTurn,
  runChatTurnWithVerify,
  runChatTurnWithVerifyResult,
  loadAgencyConfig,
  resolveApiKey,
  bootstrapRuntime,
  autoResumeRecoverableTasks,
  discoverRecoverableTasks,
} from "@agency/core";
import { out, handleError } from "../utils.js";

const PROVIDER_IDS = [
  "openai",
  "anthropic",
  "google",
  "openrouter",
  "nvidia",
  "local",
] as const;

type ProviderId = (typeof PROVIDER_IDS)[number];

function isProviderId(value: string): value is ProviderId {
  return (PROVIDER_IDS as readonly string[]).includes(value);
}

export function registerChat(program: Command) {
  program
    .command("chat")
    .argument("<prompt>", "Prompt for hybrid route + assistant reply")
    .description(
      "Hybrid route + optional LLM reply (human-readable by default)"
    )
    .option("--project-root <path>", "Project root for routing weights")
    .option(
      "--provider <id>",
      `LLM provider override (${PROVIDER_IDS.join(", ")})`
    )
    .option(
      "--no-llm",
      "Force route-only output (skip LLM even if API key is set)"
    )
    .option(
      "--budget <mode>",
      "Token budget: tight | normal | deep (default normal)",
      "normal"
    )
    .option("--json", "Machine-readable JSON (automation / debugging)")
    .option("--stream", "Stream LLM tokens to stdout as they arrived")
    .option("--quiet", "Suppress routing meta on stderr")
    .option(
      "--max-loops <number>",
      "Maximum execution loops for tool calls",
      (val) => parseInt(val, 10)
    )
    .action(
      async (
        prompt: string,
        options: {
          projectRoot?: string;
          provider?: string;
          // Commander stores `--no-llm` as `llm: false` (default true).
          llm?: boolean;
          budget?: string;
          json?: boolean;
          stream?: boolean;
          quiet?: boolean;
          maxLoops?: number;
        }
      ) => {
        if (options.json) {
          out.configure({ surface: "json", quiet: options.quiet });
        } else {
          out.configure({ surface: "human", quiet: options.quiet });
        }

        if (options.provider && !isProviderId(options.provider)) {
          out.failure({
            title: "unknown provider",
            consequence: `${options.provider} is not available`,
            recovery: `available: ${PROVIDER_IDS.join(", ")}`,
          });
          process.exit(1);
        }

        // Fail fast with actionable guidance when the LLM step has no usable key,
        // instead of letting the provider layer throw a low-level error deep in
        // the pipeline. Routing still runs under --no-llm, and `local` needs no key.
        if (options.llm !== false) {
          const cfg = loadAgencyConfig();
          const effectiveProvider = options.provider ?? cfg.defaultProvider;
          if (effectiveProvider !== "local") {
            const profile = cfg.providers?.[effectiveProvider];
            const key = resolveApiKey(profile);
            if (!key?.trim()) {
              out.failure({
                title: "no API key",
                consequence: `provider "${effectiveProvider}" has no resolvable API key`,
                recovery:
                  "set one with `agency config init` / `agency config set`, export the ${ENV_VAR} it references, or use `/connect` in the TUI — or pass --no-llm for route-only output",
              });
              process.exit(1);
            }
          }
        }

        const skillsRoot = resolveSkillsRoot();
        const projectRoot =
          options.projectRoot ?? getWorkspaceRoot(process.cwd());

        // Startup: attach the durable event journal and surface any interrupted
        // tasks left by a prior (possibly crashed) run. Never blocks the turn.
        try {
          const boot = bootstrapRuntime(projectRoot);
          if (!options.quiet && !options.json && boot.mutationRecovery.length > 0) {
            const files = boot.mutationRecovery.reduce((n, r) => n + r.rolledBack, 0);
            out.meta(
              `Rolled back ${files} half-applied file change(s) from ${boot.mutationRecovery.length} interrupted commit(s) (atomic rollback).`
            );
          }
          if (boot.autoRecover) {
            // Hardened: actually re-run any task a prior crashed run left
            // mid-flight, behind a per-task crash-loop counter. Paused tasks are
            // intentional and only surfaced (not auto-run).
            const outcomes = await autoResumeRecoverableTasks(projectRoot);
            if (!options.quiet && !options.json) {
              for (const o of outcomes) {
                if (o.abandoned) {
                  out.meta(
                    `Task ${o.taskId} abandoned after ${o.attempts} failed resume attempt(s) — run \`agency task resume ${o.taskId}\` manually`
                  );
                } else if (o.status === "done") {
                  out.meta(`Auto-resumed task ${o.taskId} → completed`);
                } else {
                  out.meta(
                    `Auto-resume of task ${o.taskId} → ${o.error ? `error: ${o.error}` : o.status ?? "incomplete"}`
                  );
                }
              }
              const paused = discoverRecoverableTasks(projectRoot).filter((t) => t.status === "paused");
              if (paused.length > 0) {
                out.meta(`${paused.length} paused task(s) — resume with \`agency task resume <id>\``);
              }
            }
          } else if (!options.quiet && !options.json && boot.recoverable.length > 0) {
            out.meta(
              `${boot.recoverable.length} interrupted task(s) — resume with \`agency task resume <id>\` or see \`agency status\``
            );
          }
        } catch {
          // Bootstrap/auto-resume are best-effort; never block the chat turn.
        }

        try {
          const turnInput = {
            prompt,
            projectRoot,
            skillsRoot,
            providerId: options.provider as ProviderId | undefined,
            noLlm: options.llm === false,
            budget: options.budget as "tight" | "normal" | "deep" | undefined,
            maxLoops: options.maxLoops,
          };

          if (options.stream && !options.json) {
            // Verify-aware streaming turn: under the hardened profile (or
            // AGENCY_VERIFY_MAIN_TURN) a turn that edits files is checked against
            // the project's real acceptance scripts and self-corrects on failure.
            // Flags off → byte-identical to runChatTurnWithStream.
            const result = await runChatTurnWithVerify(turnInput, {
              onRoute: (ev) => {
                if (!options.quiet) {
                  const chips = [
                    `intent ${ev.route.intent}`,
                    `workflow ${ev.route.workflow}`,
                    `provider ${ev.route.provider}`,
                  ].join("  ·  ");
                  out.meta(chips);
                }
              },
              onDelta: (delta) => {
                process.stdout.write(delta);
              },
            });
            process.stdout.write("\n");
            const tail = formatSuggestionsOnly(result.suggestedCommands);
            if (tail) out.passthrough(tail);
            return;
          }

          // Human one-shot self-heals (verify-aware) under the hardened profile;
          // `--json` stays on the plain turn so machine consumers get a single
          // deterministic result (no self-heal re-runs). Byte-identical when off.
          const result = options.json
            ? await runChatTurn(turnInput)
            : await runChatTurnWithVerifyResult(turnInput);
          const surface = options.json ? "json" : "human";
          const { stdout, meta } = formatChatTurnForSurface(result, surface);

          if (!options.quiet) {
            for (const line of meta) {
              out.meta(line);
            }
          }
          out.passthrough(stdout);
        } catch (err) {
          handleError(err, "chat failed");
        }
      }
    );
}
