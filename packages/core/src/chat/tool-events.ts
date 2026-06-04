import { EventBus } from "../events/event-bus.js";
import { isErrorResult, isNonZeroExitResult } from "./tool-result-status.js";

/**
 * Tool-lifecycle events (Phase A of docs/EVENT_FIRST_RUNTIME.md).
 *
 * Today the tool lifecycle is injected as `⚡ [SYSTEM: …]` text on the assistant
 * `onDelta` stream, which the TUI then re-parses — the "TUI parses assistant
 * text" violation. This module publishes the lifecycle as STRUCTURED events on
 * the EventBus the TUI already subscribes to (like `subagent:*`/`plan:updated`),
 * so a later Activity Timeline can render from events instead of text.
 *
 * Phase A is purely additive: these events are emitted alongside the existing
 * text injection; nothing consumes them yet, so there is no behaviour change.
 * Phase B adds the timeline subscriber; Phase C removes the text injection.
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

// NOTE: the "writing" subset below (write/append/edit/delete/move/create_directory)
// overlaps conceptually with `isFileWritingTool` (tool-harness.ts), which is a
// boolean union used for filesWritten tracking. They serve different shapes
// (boolean vs per-tool action) so they can't share one list cleanly — keep them
// aligned if either tool set changes.
const FS_READ = new Set(["read_file", "view_file"]);
const FS_WRITE = new Set(["write_file", "append_file", "create_directory"]);
const FS_EDIT = new Set(["edit_file", "batch_edit", "ast_edit", "multi_replace_file_content"]);
const FS_DELETE = new Set(["delete_file"]);
const FS_MOVE = new Set(["move_file"]);
const SEARCH = new Set(["grep_search", "find_files"]);
const EXEC = new Set(["execute_command", "run_command"]);
const AGENT = new Set(["dispatch_subagent"]);

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
 * the shared predicates (tool-result-status.ts) the circuit breaker uses, but —
 * unlike the breaker — is NOT gated on `breakerFailedExits`: the timeline always
 * shows the truth of the outcome.
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
  /** finished/failed only. */
  ok?: boolean;
  summary?: string;
  durationMs?: number;
}

/** Emit `tool:started`. Fire-and-forget (display/journal is best-effort). */
export function emitToolStarted(args: {
  name: string;
  toolArgs: Record<string, any>;
  seq: number;
  turnId: string;
  agentId?: string;
}): void {
  const { category, action } = classifyTool(args.name);
  const ev: ToolEvent = {
    name: args.name,
    category,
    action,
    target: toolTarget(args.name, args.toolArgs),
    seq: args.seq,
    turnId: args.turnId,
    agentId: args.agentId,
  };
  void EventBus.getInstance().publish(TOOL_STARTED, ev);
}

/** Emit `tool:finished` (ok) or `tool:failed` (!ok). Fire-and-forget. */
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
  const { category, action } = classifyTool(args.name);
  const ev: ToolEvent = {
    name: args.name,
    category,
    action,
    target: toolTarget(args.name, args.toolArgs),
    seq: args.seq,
    turnId: args.turnId,
    agentId: args.agentId,
    ok: args.ok,
    summary: args.summary,
    durationMs: args.durationMs,
  };
  void EventBus.getInstance().publish(args.ok ? TOOL_FINISHED : TOOL_FAILED, ev);
}
