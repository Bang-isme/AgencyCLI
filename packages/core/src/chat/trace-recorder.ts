import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ActiveTelemetryTracker } from "@agency/telemetry";
import { getRuntimeFlags } from "../runtime/flags.js";

/**
 * Roadmap §2.5 — the RECORD half of behaviour-level replay regression.
 *
 * Wraps the (previously producer-less) telemetry {@link ActiveTelemetryTracker}
 * and persists a {@link DeterministicExecutionTrace} to
 * `.agency/traces/<sessionId>.json`. The replay/regression CONSUMER already
 * exists — telemetry's `ReplayEngine` + benchmark's `runRegressionReplay`
 * (`interceptToolCall` fuzzy-matches recorded tool outputs and flags drift) —
 * but nothing produced traces from a live session. This supplies them.
 *
 * Recording adds a per-tool array push, so it is OFF unless `AGENCY_TRACE_RECORD`
 * is set (opt-in in both profiles). When off, {@link createTraceRecorder} returns
 * null and every call site is a no-op, keeping the turn path byte-identical.
 * `save()` is best-effort and never throws into the turn.
 */
export class SessionTraceRecorder {
  private tracker = new ActiveTelemetryTracker();

  constructor(
    private readonly projectRoot: string,
    private readonly sessionId: string,
    goal: string
  ) {
    this.tracker.startSession(sessionId, goal);
  }

  recordTool(name: string, args: Record<string, any>, output: unknown): void {
    this.tracker.recordToolCall(name, args, output);
  }

  recordTurn(durationMs: number): void {
    this.tracker.recordTurn(durationMs);
  }

  /** Record the model's completion for one outer-loop iteration (§2.5). */
  recordLlmResponse(text: string, finishReason?: string): void {
    this.tracker.recordLlmResponse(text, finishReason);
  }

  /** Persist the trace to `.agency/traces/<sessionId>.json`. Never throws. */
  save(): void {
    try {
      const dir = join(this.projectRoot, ".agency", "traces");
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      const file = join(dir, `${this.sessionId}.json`);
      writeFileSync(file, JSON.stringify(this.tracker.exportTrace(), null, 2), "utf8");
    } catch {
      // tracing is best-effort observability — must never break a turn
    }
  }
}

/**
 * Returns a recorder when `AGENCY_TRACE_RECORD` is on, else null (zero overhead —
 * the turn path stays byte-identical with the flag off).
 */
export function createTraceRecorder(
  projectRoot: string,
  sessionId: string,
  goal: string
): SessionTraceRecorder | null {
  if (!getRuntimeFlags().traceRecord) return null;
  return new SessionTraceRecorder(projectRoot, sessionId, goal);
}
