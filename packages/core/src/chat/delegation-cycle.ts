import type { ParallelDispatchReport } from "../agents/dispatch-report.js";
import { formatReportForModel } from "../agents/dispatch-report.js";
import { EventBus } from "../events/event-bus.js";
import { getRuntimeFlags } from "../runtime/flags.js";

export type DelegationPhase = "idle" | "executing_batch" | "awaiting_synthesis" | "complete";

export interface DelegationCycleState {
  phase: DelegationPhase;
  report?: ParallelDispatchReport;
  batchId?: string;
}

const cycles = new Map<string, DelegationCycleState>();

function key(sessionId: string): string {
  return sessionId;
}

export function getDelegationState(sessionId: string): DelegationCycleState {
  return cycles.get(key(sessionId)) ?? { phase: "idle" };
}

export function startDelegationBatch(sessionId: string, batchId: string, batchLabel?: string): void {
  cycles.set(key(sessionId), { phase: "executing_batch", batchId });
  void EventBus.getInstance().publish("delegation:batch-started", {
    sessionId,
    batchId,
    batchLabel,
    timestamp: Date.now(),
  });
}

export function completeDelegationBatch(sessionId: string, report: ParallelDispatchReport): void {
  if (!getRuntimeFlags().forcedDelegationSynthesis) {
    cycles.set(key(sessionId), { phase: "complete", report, batchId: report.batchId });
    void EventBus.getInstance().publish("delegation:complete", {
      sessionId,
      batchId: report.batchId,
      report,
    });
    return;
  }
  cycles.set(key(sessionId), {
    phase: "awaiting_synthesis",
    report,
    batchId: report.batchId,
  });
  void EventBus.getInstance().publish("delegation:synthesis-started", {
    sessionId,
    batchId: report.batchId,
    timestamp: Date.now(),
  });
}

export function clearDelegationCycle(sessionId: string): void {
  cycles.delete(key(sessionId));
}

export function needsDelegationSynthesis(sessionId: string): boolean {
  return getDelegationState(sessionId).phase === "awaiting_synthesis";
}

export function buildSynthesisUserMessage(sessionId: string): string | null {
  const state = getDelegationState(sessionId);
  if (state.phase !== "awaiting_synthesis" || !state.report) return null;
  return [
    "[SYSTEM: Parallel subagent batch completed. Synthesize the results for the user.]",
    "",
    formatReportForModel(state.report),
    "",
    "Instructions: Summarize outcomes per task (success/failure), list files created or changed, note remaining errors, and suggest next steps. Do NOT call dispatch_parallel or dispatch_subagent again unless the user explicitly asks. Respond in the user's language.",
  ].join("\n");
}

export function markDelegationSynthesisComplete(sessionId: string): void {
  const state = getDelegationState(sessionId);
  if (state.report) {
    cycles.set(key(sessionId), { phase: "complete", report: state.report, batchId: state.batchId });
    void EventBus.getInstance().publish("delegation:complete", {
      sessionId,
      batchId: state.batchId,
      report: state.report,
    });
  } else {
    clearDelegationCycle(sessionId);
  }
}

/** Tools allowed during the forced synthesis turn. */
export const SYNTHESIS_ALLOWED_TOOLS = new Set([
  "read_file",
  "view_file",
  "grep_search",
  "grep_file",
  "find_files",
  "list_dir",
  "file_info",
]);

export function isSynthesisBlockedTool(name: string): boolean {
  if (!getRuntimeFlags().forcedDelegationSynthesis) return false;
  return !SYNTHESIS_ALLOWED_TOOLS.has(name);
}
