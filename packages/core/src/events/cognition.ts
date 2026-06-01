import { EventBus } from "./event-bus.js";
import { getRuntimeFlags } from "../runtime/flags.js";
import {
  RuntimeThoughtEvent,
  RuntimeThoughtSource,
  RuntimeThoughtPhase,
  RuntimeThoughtSeverity
} from "@agency/contracts";

/**
 * Publishes a structured RuntimeThoughtEvent to the EventBus so the TUI
 * CognitionPanel can narrate execution state, planner decisions, adaptations, and
 * safety policies. The panel already subscribes to `thought:emitted`; this is its
 * producer.
 *
 * Gated centrally by the `cognitionStream` flag (off in legacy) so every call site
 * can stay unconditional and the turn path is byte-identical when the flag is off.
 * Best-effort: a publish failure must never break a turn.
 */
export function emitThought(thought: {
  source: RuntimeThoughtSource;
  phase: RuntimeThoughtPhase;
  severity: RuntimeThoughtSeverity;
  message: string;
  confidence?: "high" | "medium" | "low";
  workerId?: string;
  branchId?: string;
  collapsible?: boolean;
  hiddenByDefault?: boolean;
}): void {
  if (!getRuntimeFlags().cognitionStream) return;
  const event: RuntimeThoughtEvent = {
    id: `thought-${Math.random().toString(36).substring(2, 9)}`,
    timestamp: Date.now(),
    ...thought,
  };
  try {
    void EventBus.getInstance().publish("thought:emitted", event);
  } catch {
    /* cognition narration is best-effort observability — never break a turn */
  }
}

/**
 * Narrate one verify-loop round to the cognition panel (self-correction).
 * Wired into the loop's `onRound` hook at every verify site — subagent dispatch
 * (both the SEARCH/REPLACE and the XML tool-call edit paths) and the main-turn
 * verify — so this narration lives in exactly one place instead of being copied
 * into each call site. Only a *failed* round is narrated, as an adaptation (the
 * loop is about to re-attempt); the terminal pass/fail is already carried by the
 * existing lifecycle events. Delegates gating to `emitThought` (no-op unless
 * `cognitionStream` is on).
 */
export function emitVerifyRoundThought(
  round: number,
  verify: { passed: boolean; failures: string },
  opts: { workerId?: string } = {}
): void {
  if (verify.passed) return;
  const firstLine =
    verify.failures
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l.length > 0) ?? "verification failed";
  emitThought({
    source: "validator",
    phase: "validation",
    severity: "adaptation",
    confidence: "medium",
    message: `Verification failed (round ${round}) — self-correcting: ${firstLine.slice(0, 140)}`,
    workerId: opts.workerId,
  });
}
