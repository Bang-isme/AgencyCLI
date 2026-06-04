import type { WorkerStep } from "../components/WorkerProgress.js";

/**
 * Presentation-facing live status of a dispatched subagent, derived from the
 * worker tracker / `subagent:*` events and rendered inline by the conversation's
 * Workers panel (`Conversation.tsx`). Distinct from the tracker's internal
 * `WorkerLifecycleState` (`state/semantic-orchestration.ts`), which is the
 * richer source model this is mapped down from in `App.flushSubagents`.
 */
export interface SubagentStatus {
  agentId: string;
  task: string;
  /**
   * `interrupted` = the worker was still non-terminal when its turn ended (halted
   * by the circuit breaker / a rate-limit retry loop) and was finalized so its
   * elapsed stops climbing a fake "running" — distinct from a genuine `error`
   * the worker reported. Only produced when the `workerPanelLifecycle` flag is on.
   */
  status: "queued" | "running" | "done" | "error" | "interrupted";
  elapsedMs?: number;
  /**
   * Wall-clock spawn timestamp (ms). Lets an elapsed readout self-tick from a
   * stable anchor instead of the parent re-flushing the whole subagents array.
   */
  spawnTs?: number;
  result?: string;
  /** Worker-style progress steps (if available) */
  steps?: WorkerStep[];
  /** Current execution phase label */
  phase?: string;
  thought?: string;
  text?: string;
}
