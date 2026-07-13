import { EventBus } from "../events/event-bus.js";
import { isErrorResult, isNonZeroExitResult } from "./tool-result-status.js";
import {
  lifecycleFromToolEvent,
  publishActionLifecycle,
  type ActionLifecycleState,
} from "../product/action-lifecycle.js";

/**
 * Tool-lifecycle events (Phase A of docs/EVENT_FIRST_RUNTIME.md).
 *
 * Today the tool lifecycle is injected as `⚡ [SYSTEM: …]` text on the assistant
 * `onDelta` stream, which the TUI then re-parses — the "TUI parses assistant
 * text" violation. This module publishes the lifecycle as STRUCTURED events on
 * the EventBus the TUI already subscribes to (like `subagent:*`/`plan:updated`),
 * so a later Activity Timeline can render from events instead of text.
 */

export type ToolCategory = "fs" | "exec" | "search" | "agent" | "memory" | "other";
export type ToolAction =
  | "read"
  | "write"
  | "edit"
  | "delete"
  | "move"
  | "exec"
  | "search"
  | "dispatch"
  | "remember"
  | "other";

export const TOOL_STARTED = "tool:started";
export const TOOL_FINISHED = "tool:finished";
export const TOOL_FAILED = "tool:failed";

const FS_READ = new Set(["read_file", "view_file"]);
const FS_WRITE = new Set(["write_file", "append_file", "create_directory"]);
const FS_EDIT = new Set(["edit_file", "batch_edit", "ast_edit", "multi_replace_file_content"]);
const FS_DELETE = new Set(["delete_file"]);
const FS_MOVE = new Set(["move_file"]);
const SEARCH = new Set(["grep_search", "find_files"]);
const EXEC = new Set(["execute_command", "run_command"]);
const AGENT = new Set(["dispatch_subagent"]);
const NON_DISPLAY_ACTIVITY = new Set(["update_plan"]);

export function shouldEmitToolLifecycleEvent(name: string): boolean {
  return !NON_DISPLAY_ACTIVITY.has(name);
}

/** Classify a tool name into a coarse category + action for timeline display. */
export function classifyTool(name: string): { category: ToolCategory; action: ToolAction } {
  if (FS_READ.has(name)) return { category: "fs", action: "read" };
  if (FS_WRITE.has(name)) return { category: "fs", action: "write" };
  if (FS_EDIT.has(name)) return { category: "fs", action: "edit" };
  if (FS_DELETE.has(name)) return { category: "fs", action: "delete" };
  if (FS_MOVE.has(name)) return { category: "fs", action: "move" };
  if (SEARCH.has(name)) return { category: "search", action: "search" };
  if (EXEC.has(name)) return { category: "exec", action: "exec" };
  if (AGENT.has(name)) return { category: "agent", action: "dispatch" };
  if (name === "remember") return { category: "memory", action: "remember" };
  if (name === "forget") return { category: "memory", action: "delete" };
  return { category: "other", action: "other" };
}

/** The human target of a tool call (file path, command, or worker) for display. */
export function toolTarget(name: string, args: Record<string, any>): string {
  const { category } = classifyTool(name);
  if (category === "exec") return String(args.command ?? args.cmd ?? "").slice(0, 120);
  if (category === "agent") return args.agentId ? `worker.${args.agentId}` : "subagent";
  const p = args.path ?? args.AbsolutePath ?? args.TargetFile ?? args.pattern ?? "";
  return String(p).slice(0, 200);
}

/**
 * Whether a tool RESULT string represents a failure, for timeline status. Uses
 * the shared predicates (tool-result-status.ts) the circuit breaker uses.
 */
export function toolResultIsFailure(result: string): boolean {
  return isErrorResult(result) || isNonZeroExitResult(result);
}

export interface ToolEvent {
  name: string;
  category: ToolCategory;
  action: ToolAction;
  target: string;
  /** Per-turn monotonic counter so the timeline orders deterministically. */
  seq: number;
  turnId: string;
  agentId?: string;
  dispatchId?: string;
  /** finished/failed only. */
  ok?: boolean;
  summary?: string;
  durationMs?: number;
}

/** Emit `tool:started` and `action:lifecycle` (state: running). */
export function emitToolStarted(args: {
  name: string;
  toolArgs: Record<string, any>;
  seq: number;
  turnId: string;
  agentId?: string;
}): void {
  if (!shouldEmitToolLifecycleEvent(args.name)) return;
  const { category, action } = classifyTool(args.name);
  const target = toolTarget(args.name, args.toolArgs);
  const ev: ToolEvent = {
    name: args.name,
    category,
    action,
    target,
    seq: args.seq,
    turnId: args.turnId,
    agentId: args.agentId,
    dispatchId: typeof args.toolArgs.dispatchId === "string" ? args.toolArgs.dispatchId : undefined,
  };
  void EventBus.getInstance().publish(TOOL_STARTED, ev);

  const lifecycleEvent = lifecycleFromToolEvent("running", {
    name: args.name,
    target,
    seq: args.seq,
    turnId: args.turnId,
    agentId: args.agentId,
    dispatchId: ev.dispatchId,
    category,
    action,
    startedAt: Date.now(),
  });
  publishActionLifecycle(lifecycleEvent);
}

/** Emit `tool:finished` (ok) or `tool:failed` (!ok) and `action:lifecycle`. */
export function emitToolFinished(args: {
  name: string;
  toolArgs: Record<string, any>;
  seq: number;
  turnId: string;
  agentId?: string;
  ok: boolean;
  summary: string;
  durationMs: number;
}): void {
  if (!shouldEmitToolLifecycleEvent(args.name)) return;
  const { category, action } = classifyTool(args.name);
  const target = toolTarget(args.name, args.toolArgs);
  const ev: ToolEvent = {
    name: args.name,
    category,
    action,
    target,
    seq: args.seq,
    turnId: args.turnId,
    agentId: args.agentId,
    dispatchId: typeof args.toolArgs.dispatchId === "string" ? args.toolArgs.dispatchId : undefined,
    ok: args.ok,
    summary: args.summary,
    durationMs: args.durationMs,
  };
  void EventBus.getInstance().publish(args.ok ? TOOL_FINISHED : TOOL_FAILED, ev);

  const state: ActionLifecycleState = args.ok ? "succeeded" : "failed";
  const lifecycleEvent = lifecycleFromToolEvent(state, {
    name: args.name,
    target,
    seq: args.seq,
    turnId: args.turnId,
    agentId: args.agentId,
    dispatchId: ev.dispatchId,
    category,
    action,
    summary: args.summary,
    durationMs: args.durationMs,
    startedAt: Date.now() - args.durationMs,
  });
  publishActionLifecycle(lifecycleEvent);
}

/** Emit action:lifecycle with state "cancelled" (e.g. circuit breaker or user abort). */
export function emitToolCancelled(args: {
  name: string;
  toolArgs: Record<string, any>;
  seq: number;
  turnId: string;
  agentId?: string;
  reason?: string;
}): void {
  if (!shouldEmitToolLifecycleEvent(args.name)) return;
  const { category, action } = classifyTool(args.name);
  const target = toolTarget(args.name, args.toolArgs);
  const lifecycleEvent = lifecycleFromToolEvent("cancelled", {
    name: args.name,
    target,
    seq: args.seq,
    turnId: args.turnId,
    agentId: args.agentId,
    category,
    action,
    summary: args.reason ?? "Execution cancelled",
  });
  publishActionLifecycle(lifecycleEvent);
}

/** Emit action:lifecycle with state "incomplete" (e.g. truncated output or loop limit). */
export function emitToolIncomplete(args: {
  name: string;
  toolArgs: Record<string, any>;
  seq: number;
  turnId: string;
  agentId?: string;
  summary?: string;
}): void {
  if (!shouldEmitToolLifecycleEvent(args.name)) return;
  const { category, action } = classifyTool(args.name);
  const target = toolTarget(args.name, args.toolArgs);
  const lifecycleEvent = lifecycleFromToolEvent("incomplete", {
    name: args.name,
    target,
    seq: args.seq,
    turnId: args.turnId,
    agentId: args.agentId,
    category,
    action,
    summary: args.summary ?? "Execution incomplete",
  });
  publishActionLifecycle(lifecycleEvent);
}

