import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { Command } from "commander";
import { loadTraceFile, runRegressionReplay } from "@agency/benchmark";
import { parseToolCalls } from "@agency/core";
import { resolveProjectRoot } from "../resolve-project.js";
import { out, exitOk, exitFail, handleError } from "../utils.js";

/**
 * Roadmap §2.5 — the live driver for behaviour-trace replay regression.
 *
 * The CONSUMER (`runRegressionReplay` + telemetry `ReplayEngine`) and the
 * PRODUCER (`SessionTraceRecorder` → `.agency/traces/<sessionId>.json`, opt-in via
 * `AGENCY_TRACE_RECORD`) already existed but nothing connected them on the CLI —
 * `runRegressionReplay` had no caller outside tests. This wires them, reusing both
 * verbatim (no new replay/hash logic).
 *
 * The trace types are derived structurally from `runRegressionReplay` (via
 * `Parameters`/`ReturnType`), so the cli needs no direct `@agency/telemetry`
 * dependency even though the trace type originates there: it only leaks through
 * `@agency/benchmark`'s signature, and tsc resolves it transitively from
 * benchmark's own node_modules. `package-cycles.test.ts` guards that cli's
 * declared `@agency/*` deps stay in sync with what it actually imports.
 */
type RegressionTrace = Parameters<typeof runRegressionReplay>[0];
type RegressionExecutor = Parameters<typeof runRegressionReplay>[1];
type RegressionResult = Awaited<ReturnType<typeof runRegressionReplay>>;

/**
 * Drives the replay engine the way a re-executing agent would: consume each
 * recorded turn's timing, then each recorded tool call in order. The engine is
 * built from the *reference* trace, so `interceptToolCall` throws
 * `[Replay Deviation]` when the reference has no matching recorded output — that
 * is how behavioural drift surfaces.
 */
function replaySequenceOf(source: RegressionTrace): RegressionExecutor {
  return async (engine) => {
    assertTraceShape(source);
    for (let i = 0; i < source.timings.length; i++) engine.nextTurnDuration();
    for (const entry of source.toolOutputs) {
      engine.interceptToolCall(entry.toolName, entry.arguments);
    }
    // §2.5 — also reproduce each recorded LLM completion in order (no-op for
    // pre-§2.5 traces that recorded none). A differing/extra/missing response
    // surfaces as drift, same as a tool deviation.
    for (const entry of source.llmResponses ?? []) {
      engine.interceptLlmResponse(entry.text);
    }
  };
}

/** Stable JSON for argument comparison (key order shouldn't matter). */
function canonicalArgs(args: Record<string, any>): string {
  const keys = Object.keys(args ?? {}).sort();
  return JSON.stringify(keys.map((k) => [k, args[k]]));
}

interface ReexecResult {
  success: boolean;
  derived: number;
  recorded: number;
  deviation?: string;
  error?: string;
}

/**
 * Roadmap §2.5 re-execution: re-derive the tool-call sequence from the recorded
 * model completions using the REAL `parseToolCalls`, and assert it matches the
 * tool calls actually executed (`toolOutputs`). This verifies the harness's
 * interpret-the-model→dispatch-tools step is deterministic and consistent with
 * what ran — a regression in `parseToolCalls` or tool-name handling surfaces
 * here. It runs NO tools and has no side effects (the safe core of "re-execute
 * the agent"); a full live re-run via a ReplayProvider would additionally need
 * to intercept tool execution, the gate and episode writes.
 */
function reexecuteTrace(trace: RegressionTrace): ReexecResult {
  const responses = trace.llmResponses ?? [];
  const recorded = trace.toolOutputs ?? [];
  if (responses.length === 0) {
    return {
      success: false,
      derived: 0,
      recorded: recorded.length,
      error: "trace has no recorded llmResponses to re-execute (record with AGENCY_TRACE_RECORD=1 on a build that captures completions)",
    };
  }

  // Re-derive tool calls from the recorded completions, in order.
  const derived: { name: string; arguments: Record<string, any> }[] = [];
  for (const r of responses) {
    for (const tc of parseToolCalls(r.text ?? "")) derived.push(tc);
  }

  const max = Math.max(derived.length, recorded.length);
  for (let i = 0; i < max; i++) {
    const d = derived[i];
    const rec = recorded[i];
    if (!d || !rec) {
      return {
        success: false,
        derived: derived.length,
        recorded: recorded.length,
        deviation: `count mismatch: re-derived ${derived.length} tool call(s) from the completions vs ${recorded.length} recorded as executed`,
      };
    }
    if (d.name !== rec.toolName || canonicalArgs(d.arguments) !== canonicalArgs(rec.arguments)) {
      return {
        success: false,
        derived: derived.length,
        recorded: recorded.length,
        deviation: `tool #${i + 1} diverged: re-parsed "${d.name}" vs recorded "${rec.toolName}"`,
      };
    }
  }

  return { success: true, derived: derived.length, recorded: recorded.length };
}

function assertTraceShape(trace: RegressionTrace): void {
  const err = traceShapeError(trace, "trace");
  if (err) throw new Error(err);
}

/**
 * Returns an error string if `trace` is not a well-formed deterministic trace,
 * else null. Guards the command boundary: `runRegressionReplay`'s own catch path
 * calls `getUnconsumedCount()` (`toolOutputs.length`), which would itself throw on
 * a malformed trace — so we never feed one in.
 */
function traceShapeError(trace: RegressionTrace, path: string): string | null {
  if (!trace || !Array.isArray(trace.timings) || !Array.isArray(trace.toolOutputs)) {
    return `${path} is not a deterministic execution trace (missing timings/toolOutputs arrays)`;
  }
  return null;
}

function failResult(error: string): RegressionResult {
  return { success: false, turnsReplayed: 0, unconsumedOutputs: 0, unconsumedLlmResponses: 0, error };
}

/** Accept a path to a `.json` trace, or a bare sessionId under `.agency/traces/`. */
function resolveTracePath(projectRoot: string, ref: string): string {
  const direct = resolve(ref);
  if (existsSync(direct)) return direct;
  const withExt = ref.endsWith(".json") ? ref : `${ref}.json`;
  return join(projectRoot, ".agency", "traces", withExt);
}

function tracesDir(projectRoot: string): string {
  return join(projectRoot, ".agency", "traces");
}

interface TraceSummary {
  file: string;
  sessionId?: string;
  goal?: string;
  turns?: number;
  toolCalls?: number;
  llmResponses?: number;
  unreadable?: boolean;
}

async function summarizeTrace(file: string): Promise<TraceSummary> {
  try {
    const trace = await loadTraceFile(file);
    assertTraceShape(trace);
    return {
      file,
      sessionId: trace.sessionId,
      goal: trace.goal,
      turns: trace.timings.length,
      toolCalls: trace.toolOutputs.length,
      llmResponses: trace.llmResponses?.length ?? 0,
    };
  } catch {
    return { file, unreadable: true };
  }
}

async function listTraces(projectRoot: string, json: boolean): Promise<never> {
  const dir = tracesDir(projectRoot);
  const files = existsSync(dir)
    ? readdirSync(dir)
        .filter((f) => f.endsWith(".json"))
        .map((f) => join(dir, f))
    : [];
  const traces = await Promise.all(files.map(summarizeTrace));

  if (json) {
    console.log(JSON.stringify({ traces }, null, 2));
  } else if (traces.length === 0) {
    out.result([
      { key: "Traces", value: "none recorded yet" },
      { key: "Hint", value: "set AGENCY_TRACE_RECORD=1 to record session traces" },
    ]);
  } else {
    out.table(
      ["Session", "Turns", "Tools", "LLM", "Goal"],
      traces.map((t) =>
        t.unreadable
          ? [t.file, "—", "—", "—", "(unreadable / corrupt)"]
          : [t.sessionId ?? "?", String(t.turns), String(t.toolCalls), String(t.llmResponses), t.goal ?? ""],
      ),
      { title: `Recorded traces (${dir})` },
    );
  }
  exitOk();
}

export function registerReplayRegression(program: Command) {
  program
    .command("replay-regression")
    .argument("[trace]", "Trace file path or sessionId under .agency/traces/")
    .description(
      "Replay a recorded behaviour trace through the regression engine (roadmap §2.5). " +
        "With --baseline, check a candidate trace reproduces the baseline's tool behaviour.",
    )
    .option("--baseline <ref>", "Reference trace to check the candidate against (regression mode)")
    .option("--reexecute", "Re-derive tool calls from the recorded completions and verify they match what ran")
    .option("--list", "List recorded traces under .agency/traces/")
    .option("--project-root <path>", "Project root directory")
    .option("--json", "Emit the result as JSON to stdout")
    .action(
      async (
        traceRef: string | undefined,
        options: { baseline?: string; reexecute?: boolean; list?: boolean; projectRoot?: string; json?: boolean },
      ) => {
        try {
          const projectRoot = resolveProjectRoot(options.projectRoot);

          if (options.list || (!traceRef && !options.baseline)) {
            await listTraces(projectRoot, !!options.json);
            return;
          }
          if (!traceRef) {
            handleError(new Error("specify a trace file/sessionId (or use --list)"), "replay-regression");
            return;
          }

          const candidatePath = resolveTracePath(projectRoot, traceRef);
          if (!existsSync(candidatePath)) {
            handleError(new Error(`trace not found: ${candidatePath}`), "replay-regression");
            return;
          }
          const candidate = await loadTraceFile(candidatePath);
          const candidateErr = traceShapeError(candidate, candidatePath);

          if (options.reexecute) {
            // Re-execution mode: re-derive the tool sequence from the recorded
            // completions via the real parser and check it matches what ran.
            const r = candidateErr
              ? ({ success: false, derived: 0, recorded: 0, error: candidateErr } as ReexecResult)
              : reexecuteTrace(candidate);

            if (options.json) {
              console.log(JSON.stringify({ mode: "reexecute", trace: candidatePath, ...r }, null, 2));
            } else if (r.success) {
              out.result([
                { key: "Re-execution", value: "deterministic — completions re-derive the recorded tool calls" },
                { key: "Tool calls", value: `${r.derived} re-derived = ${r.recorded} recorded` },
              ]);
            } else {
              out.failure({
                title: "Re-execution diverged from the recorded run",
                consequence: r.error ?? r.deviation ?? "re-derived tool calls do not match what was executed",
                recovery: `inspect ${candidatePath} (the harness parse/dispatch may have changed)`,
              });
            }
            if (r.success) exitOk();
            exitFail();
            return;
          }

          if (options.baseline) {
            // Regression mode: does the candidate reproduce the baseline's recorded
            // tool interactions? Engine ← baseline outputs; executor ← candidate calls.
            const baselinePath = resolveTracePath(projectRoot, options.baseline);
            if (!existsSync(baselinePath)) {
              handleError(new Error(`baseline trace not found: ${baselinePath}`), "replay-regression");
              return;
            }
            const baseline = await loadTraceFile(baselinePath);
            const shapeErr = candidateErr ?? traceShapeError(baseline, baselinePath);
            const result = shapeErr
              ? failResult(shapeErr)
              : await runRegressionReplay(baseline, replaySequenceOf(candidate));

            if (options.json) {
              console.log(
                JSON.stringify(
                  { mode: "regression", candidate: candidatePath, baseline: baselinePath, ...result },
                  null,
                  2,
                ),
              );
            } else if (result.success) {
              out.result([
                { key: "Regression", value: "OK — candidate matches baseline behaviour" },
                { key: "Turns replayed", value: String(result.turnsReplayed) },
              ]);
            } else {
              out.failure({
                title: "Behavioural regression detected",
                consequence:
                  result.error ?? `${result.unconsumedOutputs} baseline tool outputs not reproduced`,
                recovery: `compare ${candidatePath} against ${baselinePath}`,
              });
            }
            if (result.success) exitOk();
            exitFail();
            return;
          }

          // Validate mode: confirm the trace is well-formed and fully replay-ready
          // (catches corrupt/partial/non-trace files). Not an agent regression on
          // its own — use --baseline for the behavioural comparison.
          const result = candidateErr
            ? failResult(candidateErr)
            : await runRegressionReplay(candidate, replaySequenceOf(candidate));

          if (options.json) {
            console.log(
              JSON.stringify(
                {
                  mode: "validate",
                  trace: candidatePath,
                  sessionId: candidate.sessionId,
                  toolCalls: candidate.toolOutputs?.length ?? 0,
                  llmResponses: candidate.llmResponses?.length ?? 0,
                  ...result,
                },
                null,
                2,
              ),
            );
          } else if (result.success) {
            out.result([
              { key: "Trace", value: "replay-ready — well-formed and fully consumable" },
              { key: "Session", value: candidate.sessionId },
              { key: "Turns", value: String(result.turnsReplayed) },
              { key: "Tool calls", value: String(candidate.toolOutputs.length) },
              { key: "LLM responses", value: String(candidate.llmResponses?.length ?? 0) },
            ]);
          } else {
            out.failure({
              title: "Trace is not replay-ready",
              consequence: result.error ?? "trace could not be fully replayed",
              recovery: `inspect ${candidatePath}`,
            });
          }
          if (result.success) exitOk();
          exitFail();
        } catch (err) {
          handleError(err, "replay-regression failed");
        }
      },
    );
}
