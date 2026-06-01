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
