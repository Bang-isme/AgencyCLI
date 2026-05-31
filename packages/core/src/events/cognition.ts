import { EventBus } from "./event-bus.js";
import {
  RuntimeThoughtEvent,
  RuntimeThoughtSource,
  RuntimeThoughtPhase,
  RuntimeThoughtSeverity
} from "@agency/contracts";

/**
 * Publishes a structured RuntimeThoughtEvent to the EventBus.
 * Used to expose execution state, planner decisions, adaptations, and safety policies.
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
  const event: RuntimeThoughtEvent = {
    id: `thought-${Math.random().toString(36).substring(2, 9)}`,
    timestamp: Date.now(),
    ...thought,
  };
  void EventBus.getInstance().publish("thought:emitted", event);
}
