import { existsSync, readFileSync, writeFileSync, appendFileSync, readdirSync, unlinkSync, renameSync, statSync, mkdirSync } from "node:fs";
import {
  replaceFunctionBody,
  replaceMethodBody,
  renameSymbol,
  modifyImport,
  deleteNode,
  insertFunction,
} from "../utils/ast-compiler.js";
import { resolve, join, relative, dirname, isAbsolute } from "node:path";
import { runShellCommand } from "../terminal/sandbox.js";
import { dispatchAgent } from "../agents/orchestrator.js";
import { resolveSkillsRoot } from "../skills-root.js";
import { loadIgnoreFilter } from "../index/gitignore-parser.js";
import { createCircuitBreaker, checkCircuitBreaker, recordToolSuccess, recordToolFailure, resetCircuitBreaker, consumeBreakerTrip, type CircuitBreakerState } from "../chat/circuit-breaker.js";
import { z } from "zod";
import { getModelSpec } from "@agency/providers";
import { MarkdownMemoryStore, type MemoryType } from "@agency/memory";
import { ToolRegistry } from "@agency/tooling";
import { ApprovalPolicyEngine, ApprovalRequiredError } from "../approval/index.js";
import { EventBus } from "../events/event-bus.js";
import { getRuntimeFlags } from "../runtime/flags.js";

export interface ToolCall {
  name: string;
  arguments: Record<string, string>;
}

/**
 * Parses XML-based tool calls from LLM output.
 * e.g.
 * <tool_call name="read_file">
 *   <path>src/App.tsx</path>
 * </tool_call>
 *
 * Robustness (§8.8-B): some models (observed with minimax) emit slightly
 * malformed wrappers — single-quoted or spaced name attributes
 * (`<tool_call name='x' >`) and whitespace in the closing tag
 * (`</tool_call >`, `</ tool_call>`). The wrapper regex tolerates those so a
 * recoverable call isn't silently dropped (a dropped call makes the model think
 * it ran a tool that never executed → the churn/restart-from-scratch loop). The
 * pattern stays a strict superset of the canonical form, so well-formed output
 * parses byte-identically. A wrapper with NO closing tag (truncated output) is
 * still intentionally NOT recovered — there is no safe boundary for the body.
 */
export function parseToolCalls(text: string): ToolCall[] {
  const toolCalls: ToolCall[] = [];
  const regex = /<(tool_call|invoke|invoke_call)\s+name\s*=\s*["']([^"']+)["']\s*>([\s\S]*?)<\/\s*(tool_call|invoke|invoke_call)\s*>/g;
  let match;
  while ((match = regex.exec(text)) !== null) {
    const name = match[2]!;
    const body = match[3]!;
    const args: Record<string, string> = {};
    
    // 1. Match <param name="parameter_name">parameter_value</param> (support single/double quotes, spaces)
    const paramWithNameRegex = /<param\s+name\s*=\s*['"]([^'"]+)['"]\s*>([\s\S]*?)<\/param>/g;
    let pwnMatch;
    while ((pwnMatch = paramWithNameRegex.exec(body)) !== null) {
      args[pwnMatch[1]!] = pwnMatch[2]!.trim();
    }
    
    // 2. Match standard XML tags like <path>value</path>
    const argRegex = /<([^>\s/]+)>([\s\S]*?)<\/\1>/g;
    let argMatch;
    while ((argMatch = argRegex.exec(body)) !== null) {
      const tagName = argMatch[1]!;
      if (tagName !== "param" && tagName !== "tool_call" && tagName !== "invoke" && tagName !== "invoke_call") {
        args[tagName] = argMatch[2]!.trim();
      }
    }
    
    toolCalls.push({ name, arguments: args });
  }
  return toolCalls;
}

/**
 * True when `text` contains a tool-call opening tag with no matching close tag —
 * i.e. a tool call cut off mid-stream (typically a large `write_file` whose
 * content exceeded the output-token limit). `parseToolCalls` needs the closing
 * tag, so such a call is otherwise dropped and never executed; the turn loop
 * uses this to detect the situation and reassemble the call across the model's
 * length-continuations instead of silently losing the write.
 */
export function hasUnclosedToolCall(text: string): boolean {
  const opens = (text.match(/<(?:tool_call|invoke|invoke_call)\b/g) || []).length;
  const closes = (text.match(/<\/\s*(?:tool_call|invoke|invoke_call)\s*>/g) || []).length;
  return opens > closes;
}

/**
 * Retry configuration for tool execution with exponential backoff
 */
const RETRY_CONFIG = {
  maxAttempts: 3,
  baseDelayMs: 100,
  maxDelayMs: 2000,
  retryableErrors: ["EBUSY", "EPERM", "EACCES", "EMFILE", "ENFILE", "EAGAIN"],
};

/**
 * Checks if an error is retryable based on error code or message
 */
function isRetryableError(err: any): boolean {
  if (err?.code && RETRY_CONFIG.retryableErrors.includes(err.code)) {
    return true;
  }
  const msg = String(err?.message || err).toLowerCase();
  return msg.includes("busy") || msg.includes("locked") || msg.includes("resource temporarily unavailable");
}

/**
 * Calculates delay with exponential backoff and jitter
 */
function calculateBackoff(attempt: number): number {
  const exponentialDelay = RETRY_CONFIG.baseDelayMs * Math.pow(2, attempt);
  const jitter = Math.random() * 100;
  return Math.min(exponentialDelay + jitter, RETRY_CONFIG.maxDelayMs);
}

/**
 * Executes a tool with retry logic and exponential backoff for transient failures
 */
async function executeWithRetry(
  name: string,
  fn: () => Promise<string> | string,
): Promise<string> {
  let lastError: any = null;

  for (let attempt = 0; attempt < RETRY_CONFIG.maxAttempts; attempt++) {
    try {
      const result = await fn();
      // Check if result indicates a retryable error
      if (typeof result === "string" && result.startsWith("Error:")) {
        const isRetryable = RETRY_CONFIG.retryableErrors.some(code => result.includes(code)) ||
                           result.toLowerCase().includes("busy") ||
                           result.toLowerCase().includes("locked");
        if (isRetryable && attempt < RETRY_CONFIG.maxAttempts - 1) {
          lastError = new Error(result);
          const delay = calculateBackoff(attempt);
          await new Promise(resolve => setTimeout(resolve, delay));
          continue;
        }
      }
      return result;
    } catch (err: any) {
      lastError = err;
      if (!isRetryableError(err) || attempt >= RETRY_CONFIG.maxAttempts - 1) {
        throw err;
      }
      const delay = calculateBackoff(attempt);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }

  throw lastError || new Error(`Tool ${name} failed after ${RETRY_CONFIG.maxAttempts} attempts`);
}

/**
 * Process-wide fallback circuit breaker used when a caller doesn't pass its own
 * (the legacy path — see the `scopedCircuitBreaker` flag). A per-turn breaker
 * threaded through {@link executeTool} isolates the main turn from its subagents
 * and parallel subagents from each other; without it this single state is shared
 * and reset by every turn, so a dispatched subagent wipes the main turn's breaker.
 * The trip reason now lives on the state (`trippedReason`), read via
 * {@link consumeBreakerTrip}, so concurrent breakers can't clobber each other.
 */
const circuitBreakerState = createCircuitBreaker();

export const registry = new ToolRegistry();

/**
 * Shared approval engine for the tool-execution path. Exposed so the host
 * (CLI/TUI) can configure autonomy mode and respond to approval events.
 */
export const toolApprovalEngine = new ApprovalPolicyEngine();

/**
 * Tools whose execution mutates the workspace, runs shell, or spawns agents and
 * therefore must pass through the approval gate. Read-only tools are exempt.
 */
const APPROVAL_GATED_TOOLS = new Set([
  "write_file",
  "append_file",
  "edit_file",
  "batch_edit",
  "ast_edit",
  "delete_file",
  "move_file",
  "create_directory",
  "execute_command",
  "dispatch_subagent",
]);

/**
 * Tools that write new content to `args.path`. Drives `filesWritten` in the chat
 * loop (knowledge-graph re-index + post-turn verify). Single source of truth so
 * the non-stream and stream turn paths stay in sync — they previously inlined an
 * identical `name === "write_file" || ...` check.
 */
const FILE_WRITING_TOOLS = new Set(["write_file", "append_file", "edit_file", "batch_edit", "ast_edit"]);
export function isFileWritingTool(name: string): boolean {
  return FILE_WRITING_TOOLS.has(name);
}

/** True if `target` is the project root or lives inside it. */
function isWithinRoot(projectRoot: string, target: string): boolean {
  const root = resolve(projectRoot);
  const t = resolve(target);
  if (t === root) return true;
  const rel = relative(root, t);
  // `relative` yields "" for the root, a "../"-prefixed path for an ancestor, or
  // an absolute path when there's no relative route (e.g. a different drive).
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/**
 * Returns an error string if path confinement is on and `target` escapes the
 * project root, else null. Mutating file tools call this after resolving a path
 * so a `../` traversal (or absolute path) can't write/delete outside the
 * workspace. Off (legacy) → always null → byte-identical.
 */
function pathConfinementError(projectRoot: string, target: string, label: string): string | null {
  if (!getRuntimeFlags().pathConfinement) return null;
  if (isWithinRoot(projectRoot, target)) return null;
  return `Error: ${label} resolves outside the project root — refusing (path confinement is on; AGENCY_PATH_CONFINEMENT). Use a path inside the project.`;
}

/** Maps a tool invocation to an approval action + params for risk assessment. */
function toApprovalAction(name: string, args: Record<string, any>): { action: string; params: Record<string, any> } {
  switch (name) {
    case "delete_file":
      return { action: "delete_file", params: { filePath: args.path } };
    case "move_file":
      return { action: "move_file", params: { filePath: args.source, destination: args.destination } };
    case "execute_command":
      return { action: "execute_command", params: { command: args.command } };
    case "dispatch_subagent":
      return { action: "dispatch_subagent", params: { agentId: args.agentId, task: args.task } };
    default:
      return { action: name, params: { filePath: args.path } };
  }
}

/**
 * Approval gate wired into the live tool path. Behaviour is flag-controlled:
 *   - "off":     no gating (legacy callers that never wanted approvals)
 *   - "warn":    assess risk, emit an event, log — never block (default)
 *   - "enforce": block the tool unless the approval engine authorizes it
 *
 * Closes the CRITICAL "ApprovalPolicyEngine not in tool execution path" gap.
 * Throwing here is caught by executeTool and surfaced as an "Error:" string,
 * so a denied action degrades to a tool failure rather than a crash.
 */
registry.addPreExecuteHook(async (name, args) => {
  const mode = getRuntimeFlags().approvalInToolPath;
  if (mode === "off") return;

  // MCP tools register with an `mcpSchema` marker. They run external side
  // effects (Slack/S3/GitHub/…) with unknown blast radius, so gate them all —
  // the __externalTool hint floors their risk at MEDIUM in the RiskAssessor.
  const def = registry.get(name) as { mcpSchema?: unknown } | undefined;
  const isMcp = def?.mcpSchema !== undefined;
  if (!APPROVAL_GATED_TOOLS.has(name) && !isMcp) return;

  const { action, params } = isMcp
    ? { action: name, params: { ...(args as Record<string, any>), __externalTool: true } }
    : toApprovalAction(name, args as Record<string, any>);
  const evaluation = toolApprovalEngine.evaluate(action, params);

  if (evaluation.authorized) return;

  if (mode === "warn") {
    void EventBus.getInstance().publish("approval:warn", {
      action,
      params,
      risk: evaluation.risk,
      reason: evaluation.reason,
      wouldBlock: true,
    });
    return; // non-blocking: observe what *would* have been gated
  }

  // enforce
  await EventBus.getInstance().publish("approval:required", {
    action,
    params,
    risk: evaluation.risk,
    reason: evaluation.reason,
  });
  throw new ApprovalRequiredError(
    `Approval required for "${action}" (risk: ${evaluation.risk.level}): ${evaluation.reason}`
  );
});

// 1. read_file
registry.register({
  name: "read_file",
  description: "Read contents of a file in the workspace.",
  category: "read",
  schema: z.object({
    path: z.string(),
    start_line: z.union([z.number(), z.string()]).optional(),
    end_line: z.union([z.number(), z.string()]).optional(),
    StartLine: z.union([z.number(), z.string()]).optional(),
    EndLine: z.union([z.number(), z.string()]).optional(),
  }),
  execute: async (args: any, context: any) => {
    const { projectRoot } = context;
    const pathArg = args.path || "";
    if (!pathArg) return "Error: 'path' argument is required for read_file.";
    const filePath = resolve(projectRoot, pathArg);
    if (!existsSync(filePath)) {
      return `Error: File not found at path "${pathArg}"`;
    }
    try {
      const content = readFileSync(filePath, "utf8");
      const lines = content.split("\n");
      const totalLines = lines.length;
      const startLineRaw = args.start_line || args.StartLine;
      const endLineRaw = args.end_line || args.EndLine;
      if (startLineRaw !== undefined || endLineRaw !== undefined) {
        // `String(undefined)` is "undefined" (not ""), so the old `|| "1"` /
        // `|| totalLines` defaults never fired for a MISSING bound — parseInt
        // returned NaN, producing "showing NaN-50" / a NaN-numbered dump (only
        // end given) or an EMPTY slice (only start given → end=NaN → slice(_,0)).
        // Parse each bound independently with a real fallback + NaN guard, then
        // clamp into [1, totalLines] with end ≥ start so any partial/edge range
        // returns sane lines. A fully-specified in-bounds range is unchanged.
        const parseLineArg = (raw: unknown, fallback: number): number => {
          if (raw === undefined || raw === null || String(raw).trim() === "") return fallback;
          const n = parseInt(String(raw), 10);
          return Number.isFinite(n) ? n : fallback;
        };
        const startLine = Math.min(totalLines, Math.max(1, parseLineArg(startLineRaw, 1)));
        const endLine = Math.min(totalLines, Math.max(startLine, parseLineArg(endLineRaw, totalLines)));
        const slice = lines.slice(startLine - 1, endLine);
        const numbered = slice.map((line, i) => `${startLine + i}: ${line}`);
        return `File: ${pathArg} (${totalLines} lines total, showing ${startLine}-${endLine})\n${numbered.join("\n")}`;
      }
      if (totalLines <= 500) {
        const numbered = lines.map((line, i) => `${i + 1}: ${line}`);
        return `File: ${pathArg} (${totalLines} lines total, showing 1-${totalLines})\n${numbered.join("\n")}`;
      } else {
        const startLine = 1;
        const endLine = 300;
        const slice = lines.slice(0, endLine);
        const numbered = slice.map((line, i) => `${startLine + i}: ${line}`);
        return `File: ${pathArg} (${totalLines} lines total, showing ${startLine}-${endLine}. Use start_line/end_line to read specific ranges.)\n${numbered.join("\n")}`;
      }
    } catch (err: any) {
      return `Error reading file: ${err.message || String(err)}`;
    }
  }
});

// 2. write_file
registry.register({
  name: "write_file",
  description:
    "Write (overwrite) full content to a new or existing file. For a LARGE file whose content would exceed one response, write the first portion here, then add the remaining portions with `append_file` across multiple turns — never split file content across shell commands (echo/Add-Content/heredoc), whose quoting/escaping is unreliable.",
  category: "write",
  schema: z.object({
    path: z.string(),
    content: z.string(),
  }),
  execute: async (args: any, context: any) => {
    const { projectRoot } = context;
    const pathArg = args.path || "";
    const contentArg = args.content || "";
    if (!pathArg) return "Error: 'path' argument is required for write_file.";
    const filePath = resolve(projectRoot, pathArg);
    const confined = pathConfinementError(projectRoot, filePath, `write path "${pathArg}"`);
    if (confined) return confined;
    try {
      // Create the parent directory so writing a new nested path (src/x/New.tsx
      // when src/x doesn't exist yet) succeeds instead of throwing ENOENT and
      // forcing the model to chain create_directory first (a common churn source).
      mkdirSync(dirname(filePath), { recursive: true });
      writeFileSync(filePath, contentArg, "utf8");
      // Report real bytes on disk (UTF-8), not `content.length` (JS UTF-16 code
      // units — wrong for any multibyte char) and not the stale "characters"
      // wording. This also keeps the result in lockstep with `append_file` and
      // with `summarizeToolResult`'s `(\d+) bytes` matcher, which otherwise falls
      // back to a bare "saved" in the activity line.
      return `Success: File written successfully to "${pathArg}" (${Buffer.byteLength(contentArg, "utf8")} bytes)`;
    } catch (err: any) {
      return `Error writing file: ${err.message || String(err)}`;
    }
  }
});

// 2b. append_file — build a large file incrementally without shell escaping
registry.register({
  name: "append_file",
  description:
    "Append content to the END of a file (creates it if missing). Use this to build a large file in chunks when a single write_file would be truncated by the response length limit: call write_file for the first part, then append_file for each remaining part. Reliable for any content (code, quotes, special chars) — unlike shell heredocs/Add-Content.",
  category: "write",
  schema: z.object({
    path: z.string(),
    content: z.string(),
  }),
  execute: async (args: any, context: any) => {
    const { projectRoot } = context;
    const pathArg = args.path || "";
    const contentArg = args.content || "";
    if (!pathArg) return "Error: 'path' argument is required for append_file.";
    const filePath = resolve(projectRoot, pathArg);
    const confined = pathConfinementError(projectRoot, filePath, `append path "${pathArg}"`);
    if (confined) return confined;
    try {
      const existedBefore = existsSync(filePath);
      // Same as write_file: ensure the parent dir exists so the first append to a
      // new nested path creates it rather than failing with ENOENT.
      mkdirSync(dirname(filePath), { recursive: true });
      appendFileSync(filePath, contentArg, "utf8");
      const totalChars = (() => {
        try {
          return statSync(filePath).size;
        } catch {
          return undefined;
        }
      })();
      const sizeNote = totalChars !== undefined ? `; file now ${totalChars} bytes` : "";
      return `Success: Appended ${contentArg.length} characters to "${pathArg}"${existedBefore ? "" : " (created)"}${sizeNote}`;
    } catch (err: any) {
      return `Error appending to file: ${err.message || String(err)}`;
    }
  }
});

// 2c. remember — save a durable fact to curated cross-session markdown memory
registry.register({
  name: "remember",
  description:
    "Save a durable fact to your curated cross-session memory (.agency/memory/), so it persists and is recalled in future sessions. Use it deliberately for things worth keeping: a user preference or instruction (type 'user'/'feedback'), a project decision or non-obvious finding (type 'project'), or a pointer to an external resource (type 'reference'). Do NOT save what the code/git already records or what only matters to this turn. Re-using an existing `name` updates that memory.",
  category: "write",
  schema: z.object({
    description: z.string(),
    content: z.string(),
    type: z.optional(z.union([z.literal("user"), z.literal("feedback"), z.literal("project"), z.literal("reference")])),
    name: z.optional(z.string()),
  }),
  execute: async (args: any, context: any) => {
    const { projectRoot } = context;
    const description = (args.description || "").trim();
    const content = (args.content || "").trim();
    if (!description) return "Error: 'description' is required for remember (a one-line summary).";
    if (!content) return "Error: 'content' is required for remember (the fact to save).";
    try {
      const store = MarkdownMemoryStore.forProject(projectRoot);
      const slug = store.upsert({
        name: args.name,
        description,
        type: args.type as MemoryType | undefined,
        body: content,
      });
      return `Success: Saved memory "${slug}" (type: ${args.type || "project"}). It will be recalled in future sessions.`;
    } catch (err: any) {
      return `Error saving memory: ${err.message || String(err)}`;
    }
  }
});

// 2d. forget — remove a stale/incorrect memory from curated cross-session memory
registry.register({
  name: "forget",
  description:
    "Remove a memory from your curated cross-session memory by its `name` (the slug shown in the memory index). Use only when a saved memory is stale or wrong and updating it via `remember` (same name) isn't enough — deletion is permanent.",
  category: "write",
  schema: z.object({
    name: z.string(),
  }),
  execute: async (args: any, context: any) => {
    const { projectRoot } = context;
    const name = (args.name || "").trim();
    if (!name) return "Error: 'name' is required for forget (the memory slug to remove).";
    try {
      const store = MarkdownMemoryStore.forProject(projectRoot);
      const removed = store.remove(name);
      return removed
        ? `Success: Removed memory "${name}".`
        : `No memory named "${name}" exists (nothing removed).`;
    } catch (err: any) {
      return `Error removing memory: ${err.message || String(err)}`;
    }
  }
});

// 2e. update_plan — maintain the visible plan / todo list for a multi-step task.
registry.register({
  name: "update_plan",
  description:
    "Maintain the live plan / todo list the user sees for a multi-step task. Call it when you start such a task and AGAIN whenever progress changes — pass the FULL current list each time (it replaces the previous one). `todos` is a JSON array of objects: { \"step\": string, \"status\": \"pending\" | \"in_progress\" | \"completed\" }. Keep exactly one step `in_progress`; mark a step `completed` only when its work is actually done. This is how you show what you're doing and what's next — use it instead of narrating a checklist in prose. Skip it for trivial single-step requests.",
  category: "read",
  schema: z.object({
    todos: z.string(),
  }),
  execute: async (args: any) => {
    const raw = (args.todos || "").trim();
    if (!raw) return "Error: 'todos' is required (a JSON array of { step, status }).";
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err: any) {
      return `Error parsing todos JSON: ${err.message || String(err)}`;
    }
    if (!Array.isArray(parsed)) {
      return "Error: 'todos' must be a JSON array of { step, status } objects.";
    }
    const STATUSES = new Set(["pending", "in_progress", "completed"]);
    const todos: Array<{ step: string; status: string }> = [];
    for (const item of parsed as any[]) {
      const step = String(item?.step ?? item?.title ?? item?.text ?? "").trim();
      if (!step) continue;
      const rawStatus = String(item?.status ?? "pending").trim();
      todos.push({ step, status: STATUSES.has(rawStatus) ? rawStatus : "pending" });
    }
    if (todos.length === 0) {
      return "Error: no valid todos provided (each needs a non-empty 'step').";
    }
    // Surface the plan to the TUI (and any subscriber). The status is exactly what
    // the model set per item — real per-step progress, not a decorative flip.
    void EventBus.getInstance().publish("plan:updated", { todos, timestamp: Date.now() });
    const done = todos.filter((t) => t.status === "completed").length;
    const glyph = (s: string) => (s === "completed" ? "[x]" : s === "in_progress" ? "[~]" : "[ ]");
    const lines = todos.map((t) => `${glyph(t.status)} ${t.step}`);
    return `Plan updated (${done}/${todos.length} done):\n${lines.join("\n")}`;
  },
});

/**
 * When an exact search/replace match fails, explain WHY so the model can fix it
 * in one shot instead of churning on the same near-miss (the generic "match
 * exactly" message gave it nothing to act on). Diagnoses the common causes:
 *   - line-ending (CRLF vs LF) mismatch,
 *   - indentation / trailing-whitespace-only differences — and echoes the EXACT
 *     on-disk text so the model can copy it verbatim,
 *   - a located first line (region found, block diverges below it),
 *   - a genuinely-absent block.
 * Bounded: the whitespace window scan early-exits per line; the echoed snippet
 * is capped. Pure diagnostic — only runs on the already-failed path.
 */
function diagnoseEditMismatch(content: string, search: string): string {
  if (!search) return "The search block is empty — provide the exact text to replace.";
  const contentLF = content.replace(/\r\n/g, "\n");
  const searchLF = search.replace(/\r\n/g, "\n");
  if (content.includes("\r\n") && !search.includes("\r\n") && contentLF.includes(searchLF)) {
    return "The file uses CRLF (\\r\\n) line endings but the search block uses LF (\\n). Match the file's line endings, or search for a single line without newlines.";
  }
  const contentLines = contentLF.split("\n");
  const searchLines = searchLF.split("\n");
  const searchTrim = searchLines.map((l) => l.trim());
  // Indentation / trailing-whitespace-only difference: find a window whose
  // trimmed lines all equal the trimmed search lines, then echo the REAL text.
  const MAX_SNIPPET_LINES = 40;
  for (let i = 0; i + searchLines.length <= contentLines.length; i++) {
    let ok = true;
    for (let j = 0; j < searchLines.length; j++) {
      if (contentLines[i + j]!.trim() !== searchTrim[j]) {
        ok = false;
        break;
      }
    }
    if (ok) {
      const shown = contentLines.slice(i, i + Math.min(searchLines.length, MAX_SNIPPET_LINES));
      const more =
        searchLines.length > MAX_SNIPPET_LINES
          ? `\n… (+${searchLines.length - MAX_SNIPPET_LINES} more lines)`
          : "";
      return `The text exists at line ${i + 1} but the indentation/whitespace differs. Copy this EXACT text (verbatim, including leading spaces) as your search block:\n---\n${shown.join("\n")}${more}\n---`;
    }
  }
  // First non-blank line locates the region even when the block diverges below it.
  const firstTrim = searchTrim.find((l) => l.length > 0);
  if (firstTrim) {
    const idx = contentLines.findIndex((l) => l.trim() === firstTrim);
    if (idx >= 0) {
      return `The first line of the search matches line ${idx + 1}, but the block below it doesn't match. Re-read that region with read_file and copy it verbatim before editing.`;
    }
  }
  return "The search text does not appear in the file. Re-read it with read_file and copy the target text exactly, or use ast_edit for a structural change.";
}

// 3. edit_file
registry.register({
  name: "edit_file",
  description: "Modify an existing file using a search-and-replace block.",
  category: "write",
  schema: z.object({
    path: z.string(),
    search: z.string(),
    replace: z.string(),
  }),
  execute: async (args: any, context: any) => {
    const { projectRoot } = context;
    const pathArg = args.path || "";
    const searchArg = args.search || "";
    const replaceArg = args.replace || "";
    if (!pathArg) return "Error: 'path' argument is required for edit_file.";
    const filePath = resolve(projectRoot, pathArg);
    if (!existsSync(filePath)) {
      return `Error: File not found at path "${pathArg}"`;
    }
    const confined = pathConfinementError(projectRoot, filePath, `edit path "${pathArg}"`);
    if (confined) return confined;
    try {
      const currentContent = readFileSync(filePath, "utf8");
      if (!currentContent.includes(searchArg)) {
        return `Error: Search block not found exactly in "${pathArg}". ${diagnoseEditMismatch(currentContent, searchArg)}`;
      }
      // Replace via a function so the replacement is inserted LITERALLY — a
      // plain-string replacement makes String.replace expand `$$`, `$&`, `` $` ``
      // and `$'` (corrupting any code/text that legitimately contains them).
      const newContent = currentContent.replace(searchArg, () => replaceArg);
      writeFileSync(filePath, newContent, "utf8");
      return `Success: File edited successfully at "${pathArg}"`;
    } catch (err: any) {
      return `Error editing file: ${err.message || String(err)}`;
    }
  }
});

// 3b. ast_edit — precise structural edits via the TypeScript AST
registry.register({
  name: "ast_edit",
  description:
    "Precise TypeScript/JavaScript structural edit via the AST — more reliable than edit_file's text search/replace for renames and whole-body swaps. operation: rename_symbol (target=old name, replacement=new name) | replace_function_body (target=fn name, replacement=new body; works on `function NAME(){}`, `const NAME = () => {}`, and `const NAME = function(){}` with a `{}` body) | replace_method_body (className + target=method, replacement=new body) | modify_import (target=module, addImports/removeImports=comma-separated) | delete_node (target=fn/class/var name) | insert_function (replacement=full function code).",
  category: "write",
  schema: z.object({
    path: z.string(),
    operation: z.enum([
      "rename_symbol",
      "replace_function_body",
      "replace_method_body",
      "modify_import",
      "delete_node",
      "insert_function",
    ]),
    target: z.string().optional(),
    className: z.string().optional(),
    replacement: z.string().optional(),
    addImports: z.string().optional(),
    removeImports: z.string().optional(),
  }),
  execute: async (args: any, context: any) => {
    const { projectRoot } = context;
    const pathArg = args.path || "";
    const operation = args.operation || "";
    if (!pathArg) return "Error: 'path' argument is required for ast_edit.";
    const filePath = resolve(projectRoot, pathArg);
    if (!existsSync(filePath)) return `Error: File not found at path "${pathArg}"`;
    const splitList = (s?: string) =>
      (s || "").split(",").map((x) => x.trim()).filter(Boolean);
    const confined = pathConfinementError(projectRoot, filePath, `ast_edit path "${pathArg}"`);
    if (confined) return confined;
    try {
      const src = readFileSync(filePath, "utf8");
      let updated: string;
      switch (operation) {
        case "rename_symbol":
          if (!args.target || !args.replacement)
            return "Error: rename_symbol needs 'target' (old name) and 'replacement' (new name).";
          updated = renameSymbol(src, args.target, args.replacement);
          break;
        case "replace_function_body":
          if (!args.target || args.replacement === undefined)
            return "Error: replace_function_body needs 'target' (function name) and 'replacement' (new body).";
          updated = replaceFunctionBody(src, args.target, args.replacement);
          break;
        case "replace_method_body":
          if (!args.className || !args.target || args.replacement === undefined)
            return "Error: replace_method_body needs 'className', 'target' (method name) and 'replacement' (new body).";
          updated = replaceMethodBody(src, args.className, args.target, args.replacement);
          break;
        case "modify_import":
          if (!args.target) return "Error: modify_import needs 'target' (module specifier).";
          updated = modifyImport(src, args.target, splitList(args.addImports), splitList(args.removeImports));
          break;
        case "delete_node":
          if (!args.target) return "Error: delete_node needs 'target' (function/class/variable name).";
          updated = deleteNode(src, args.target);
          break;
        case "insert_function":
          if (args.replacement === undefined)
            return "Error: insert_function needs 'replacement' (the full function code).";
          updated = insertFunction(src, args.replacement);
          break;
        default:
          return `Error: unknown ast_edit operation "${operation}".`;
      }
      writeFileSync(filePath, updated, "utf8");
      return `Success: ast_edit (${operation}) applied to "${pathArg}".`;
    } catch (err: any) {
      return `Error in ast_edit (${operation}): ${err.message || String(err)}`;
    }
  },
});

// 4. list_dir
registry.register({
  name: "list_dir",
  description: "List files and folders inside a workspace directory.",
  category: "read",
  schema: z.object({
    path: z.string().optional(),
  }),
  execute: async (args: any, context: any) => {
    const { projectRoot } = context;
    const pathArg = args.path || ".";
    const dirPath = resolve(projectRoot, pathArg);
    if (!existsSync(dirPath)) {
      return `Error: Directory not found at path "${pathArg}"`;
    }
    try {
      const entries = readdirSync(dirPath, { withFileTypes: true });
      const lines = entries.map(e => {
        const fullPath = join(dirPath, e.name);
        if (e.isDirectory()) {
          let childrenCount = 0;
          try {
            childrenCount = readdirSync(fullPath).length;
          } catch {}
          return `[DIR]  ${e.name}/ (${childrenCount} items)`;
        }
        let sizeKB = "0.0";
        try {
          const stat = statSync(fullPath);
          sizeKB = (stat.size / 1024).toFixed(1);
        } catch {}
        return `[FILE] ${e.name} (${sizeKB} KB)`;
      });
      return `Directory: ${pathArg} (${entries.length} entries)\n${lines.join("\n")}`;
    } catch (err: any) {
      return `Error listing directory: ${err.message || String(err)}`;
    }
  }
});

// 5. execute_command
registry.register({
  name: "execute_command",
  description: "Run a shell command in the native sandbox environment.",
  category: "compile",
  schema: z.object({
    command: z.string(),
  }),
  execute: async (args: any, context: any) => {
    const { projectRoot } = context;
    const commandArg = args.command || "";
    if (!commandArg) return "Error: 'command' argument is required for execute_command.";
    try {
      const res = await runShellCommand(projectRoot, commandArg, { 
        yes: true, 
        capture: true,
        signal: context.cancellationToken instanceof AbortSignal ? context.cancellationToken : undefined,
      });
      return `Exit Code: ${res.exitCode}\nStdout:\n${res.stdout}\nStderr:\n${res.stderr}`;
    } catch (err: any) {
      return `Error executing command: ${err.message || String(err)}`;
    }
  }
});

// 6. dispatch_subagent
registry.register({
  name: "dispatch_subagent",
  description: "Spawn a specialist subagent to solve a sub-task.",
  category: "other",
  schema: z.object({
    agentId: z.string(),
    task: z.string(),
  }),
  execute: async (args: any, context: any) => {
    const { projectRoot, skillsRoot } = context;
    const agentIdArg = args.agentId || "";
    const taskArg = args.task || "";
    if (!agentIdArg || !taskArg) {
      return "Error: 'agentId' and 'task' arguments are required for dispatch_subagent.";
    }
    try {
      const res = await dispatchAgent({
        agentId: agentIdArg as any,
        task: taskArg,
        projectRoot,
      }, { skillsRoot });
      return `Exit Code: ${res.exitCode}\nStdout:\n${res.stdout}\nStderr:\n${res.stderr}`;
    } catch (err: any) {
      return `Error executing subagent dispatch: ${err.message || String(err)}`;
    }
  }
});

// 7. grep_file
registry.register({
  name: "grep_file",
  description: "Search a SINGLE file (you provide its `path`) for a regex pattern; returns the matching lines. Use when you already know which file to look in — to search the whole workspace, use `grep_search` instead.",
  category: "read",
  schema: z.object({
    path: z.string(),
    pattern: z.string(),
  }),
  execute: async (args: any, context: any) => {
    const { projectRoot } = context;
    const pathArg = args.path || "";
    const patternArg = args.pattern || "";
    if (!pathArg) return "Error: 'path' argument is required for grep_file.";
    if (!patternArg) return "Error: 'pattern' argument is required for grep_file.";
    const filePath = resolve(projectRoot, pathArg);
    if (!existsSync(filePath)) {
      return `Error: File not found at path "${pathArg}"`;
    }
    try {
      const content = readFileSync(filePath, "utf8");
      const lines = content.split("\n");
      const regex = new RegExp(patternArg, "gi");
      const matches: string[] = [];
      lines.forEach((line, idx) => {
        if (regex.test(line)) {
          matches.push(`${idx + 1}: ${line}`);
        }
        regex.lastIndex = 0;
      });
      if (matches.length === 0) {
        return `No matches found for pattern "${patternArg}" in "${pathArg}"`;
      }
      return `Found ${matches.length} matches in "${pathArg}":\n${matches.join("\n")}`;
    } catch (err: any) {
      return `Error searching file: ${err.message || String(err)}`;
    }
  }
});

// 8. find_files
registry.register({
  name: "find_files",
  description: "Recursively find files in a directory by name pattern.",
  category: "read",
  schema: z.object({
    pattern: z.string().optional(),
    path: z.string().optional(),
  }),
  execute: async (args: any, context: any) => {
    const { projectRoot } = context;
    const patternArg = args.pattern || "**/*";
    const basePath = args.path || ".";
    const baseDir = resolve(projectRoot, basePath);
    if (!existsSync(baseDir)) {
      return `Error: Directory not found at path "${basePath}"`;
    }
    try {
      const results: string[] = [];
      let fileCount = 0;
      const walk = async (dir: string, depth: number = 0) => {
        if (depth > 10) return;
        if (results.length > 200) return;
        const items = readdirSync(dir);
        for (const item of items) {
          if (item.startsWith(".") || item === "node_modules") continue;
          const fullPath = join(dir, item);
          const relPath = relative(projectRoot, fullPath);
          try {
            const stat = statSync(fullPath);
            if (stat.isDirectory()) {
              await walk(fullPath, depth + 1);
            } else {
              // Strip glob wildcards AND path separators down to a bare-substring
              // match on the file name. The old code stripped only `*`, so any
              // pattern containing `/` — INCLUDING the default `**/*` (→ "/") and
              // common `**/*.ts` (→ "/.ts") — was tested with item.includes("/"),
              // which never matches a bare filename → find_files returned nothing
              // by default. Patterns without `/` are unchanged ("foo"→"foo",
              // "*.ts"→".ts"); only the previously-broken `/` cases now work.
              const simplePattern = patternArg.replace(/\*+/g, "").replace(/\//g, "");
              if (simplePattern === "" || item.includes(simplePattern)) {
                results.push(relPath);
              }
            }
          } catch {}

          fileCount++;
          if (fileCount % 50 === 0) {
            await new Promise((resolve) => setImmediate(resolve));
          }
        }
      };
      await walk(baseDir);
      if (results.length === 0) {
        return `No files found matching pattern "${patternArg}" in "${basePath}"`;
      }
      // Don't claim completeness when the 200-file cap was hit — the walk can
      // overshoot 200 (the cap is checked per-directory), so reporting
      // results.length while only showing 200 would mislead the model into
      // thinking it saw every file. Report the shown count + an honest note.
      const shown = results.slice(0, 200);
      const findCapNote =
        results.length > shown.length
          ? ` (showing the first ${shown.length} — more match; narrow the pattern or search a subdirectory)`
          : "";
      return `Found ${shown.length} files${findCapNote}:\n${shown.join("\n")}`;
    } catch (err: any) {
      return `Error finding files: ${err.message || String(err)}`;
    }
  }
});

// 9. delete_file
registry.register({
  name: "delete_file",
  description: "Delete a file from the workspace.",
  category: "write",
  schema: z.object({
    path: z.string(),
  }),
  execute: async (args: any, context: any) => {
    const { projectRoot } = context;
    const pathArg = args.path || "";
    if (!pathArg) return "Error: 'path' argument is required for delete_file.";
    const filePath = resolve(projectRoot, pathArg);
    if (!existsSync(filePath)) {
      return `Error: File not found at path "${pathArg}"`;
    }
    const confined = pathConfinementError(projectRoot, filePath, `delete path "${pathArg}"`);
    if (confined) return confined;
    try {
      unlinkSync(filePath);
      return `Success: File deleted "${pathArg}"`;
    } catch (err: any) {
      return `Error deleting file: ${err.message || String(err)}`;
    }
  }
});

// 10. move_file
registry.register({
  name: "move_file",
  description: "Move or rename a file.",
  category: "write",
  schema: z.object({
    source: z.string(),
    destination: z.string(),
  }),
  execute: async (args: any, context: any) => {
    const { projectRoot } = context;
    const sourceArg = args.source || "";
    const destArg = args.destination || "";
    if (!sourceArg) return "Error: 'source' argument is required for move_file.";
    if (!destArg) return "Error: 'destination' argument is required for move_file.";
    const sourcePath = resolve(projectRoot, sourceArg);
    const destPath = resolve(projectRoot, destArg);
    if (!existsSync(sourcePath)) {
      return `Error: Source file not found at path "${sourceArg}"`;
    }
    const srcConfined = pathConfinementError(projectRoot, sourcePath, `source "${sourceArg}"`);
    if (srcConfined) return srcConfined;
    const destConfined = pathConfinementError(projectRoot, destPath, `destination "${destArg}"`);
    if (destConfined) return destConfined;
    try {
      // Ensure the destination's parent dir exists so a move/rename INTO a new
      // folder works instead of throwing ENOENT.
      mkdirSync(dirname(destPath), { recursive: true });
      renameSync(sourcePath, destPath);
      return `Success: Moved "${sourceArg}" to "${destArg}"`;
    } catch (err: any) {
      return `Error moving file: ${err.message || String(err)}`;
    }
  }
});

// 11. grep_search
registry.register({
  name: "grep_search",
  description: "Search the WHOLE workspace recursively for a pattern (honors .gitignore, skips binaries; supports `limit`, `case_sensitive`, `is_regex`). Use to find where something appears across files — for one known file, use `grep_file` instead.",
  category: "read",
  schema: z.object({
    pattern: z.string(),
    path: z.string().optional(),
    limit: z.union([z.number(), z.string()]).optional(),
    case_sensitive: z.union([z.boolean(), z.string()]).optional(),
    is_regex: z.union([z.boolean(), z.string()]).optional(),
  }),
  execute: async (args: any, context: any) => {
    const { projectRoot } = context;
    const patternArg = args.pattern || "";
    const basePath = args.path || ".";
    const limitRaw = String(args.limit || "50");
    const caseSensitive = args.case_sensitive === true || args.case_sensitive === "true";
    const isRegex = args.is_regex === true || args.is_regex === "true";

    if (!patternArg) return "Error: 'pattern' argument is required for grep_search.";
    const baseDir = resolve(projectRoot, basePath);
    if (!existsSync(baseDir)) {
      return `Error: Base directory not found at path "${basePath}"`;
    }

    const limit = Math.min(100, Math.max(1, parseInt(limitRaw, 10) || 50));

    try {
      const filter = loadIgnoreFilter(projectRoot);
      const results: string[] = [];
      let matchCount = 0;

      const regexFlags = caseSensitive ? "g" : "gi";
      const finalPattern = isRegex 
        ? patternArg 
        : patternArg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const regex = new RegExp(finalPattern, regexFlags);

      let fileCount = 0;
      const walk = async (dir: string) => {
        if (matchCount >= limit) return;
        const entries = readdirSync(dir, { withFileTypes: true });
        
        for (const entry of entries) {
          if (matchCount >= limit) break;
          const fullPath = join(dir, entry.name);
          const relPath = relative(projectRoot, fullPath);
          const posixRelPath = relPath.replace(/\\/g, "/");

          if (entry.isDirectory()) {
            if (filter.isIgnored(posixRelPath, true)) continue;
            await walk(fullPath);
          } else if (entry.isFile()) {
            if (filter.isIgnored(posixRelPath, false)) continue;
            if (/\.(jpg|png|gif|zip|tar|gz|exe|dll|so|pdf|woff|woff2|eot|ttf|mp3|mp4|wav|avi)$/i.test(entry.name)) continue;

            try {
              const content = readFileSync(fullPath, "utf8");
              const fileLines = content.split("\n");
              fileLines.forEach((lineText, idx) => {
                if (matchCount >= limit) return;
                regex.lastIndex = 0;
                if (regex.test(lineText)) {
                  results.push(`${posixRelPath}:${idx + 1}: ${lineText.trim()}`);
                  matchCount++;
                }
              });
            } catch {}

            fileCount++;
            if (fileCount % 20 === 0) {
              await new Promise((resolve) => setImmediate(resolve));
            }
          }
        }
      };

      await walk(baseDir);
      if (results.length === 0) {
        return `No matches found for pattern "${patternArg}" in "${basePath}"`;
      }
      // The walk stops at the match limit — don't let the model assume these are
      // ALL the matches (e.g. "found every usage, safe to rename") when more may
      // exist beyond the cap. Signal it so it can narrow or raise `limit`.
      const grepCapNote =
        matchCount >= limit
          ? ` (stopped at the ${limit}-match limit — there may be more; narrow the pattern or raise \`limit\`)`
          : "";
      return `Found ${results.length} match(es) in "${basePath}"${grepCapNote}:\n${results.join("\n")}`;
    } catch (err: any) {
      return `Error running grep_search: ${err.message || String(err)}`;
    }
  }
});

// 12. create_directory
registry.register({
  name: "create_directory",
  description: "Idempotently create a directory in the workspace.",
  category: "write",
  schema: z.object({
    path: z.string(),
  }),
  execute: async (args: any, context: any) => {
    const { projectRoot } = context;
    const pathArg = args.path || "";
    if (!pathArg) return "Error: 'path' argument is required for create_directory.";
    const dirPath = resolve(projectRoot, pathArg);
    const confined = pathConfinementError(projectRoot, dirPath, `directory path "${pathArg}"`);
    if (confined) return confined;
    try {
      if (existsSync(dirPath)) {
        return `Success: Directory already exists at path "${pathArg}"`;
      }
      mkdirSync(dirPath, { recursive: true });
      return `Success: Created directory at path "${pathArg}"`;
    } catch (err: any) {
      return `Error creating directory: ${err.message || String(err)}`;
    }
  }
});

// 13. file_info
registry.register({
  name: "file_info",
  description: "Get size, lines, and metadata of a file.",
  category: "read",
  schema: z.object({
    path: z.string(),
  }),
  execute: async (args: any, context: any) => {
    const { projectRoot } = context;
    const pathArg = args.path || "";
    if (!pathArg) return "Error: 'path' argument is required for file_info.";
    const filePath = resolve(projectRoot, pathArg);
    if (!existsSync(filePath)) {
      return `Error: File not found at path "${pathArg}"`;
    }
    try {
      const stat = statSync(filePath);
      const content = readFileSync(filePath, "utf8");
      const lines = content.split("\n");
      return [
        `File: ${pathArg}`,
        `Size: ${(stat.size / 1024).toFixed(2)} KB (${stat.size} bytes)`,
        `Lines: ${lines.length}`,
        `Last Modified: ${new Date(stat.mtimeMs).toISOString()}`,
        `Directory: ${stat.isDirectory() ? "yes" : "no"}`,
      ].join("\n");
    } catch (err: any) {
      return `Error fetching file info: ${err.message || String(err)}`;
    }
  }
});

// 14. batch_edit
registry.register({
  name: "batch_edit",
  description: "Apply multiple search-and-replace edits atomically to a file.",
  category: "write",
  schema: z.object({
    path: z.string(),
    edits: z.string(),
  }),
  execute: async (args: any, context: any) => {
    const { projectRoot } = context;
    const pathArg = args.path || "";
    const editsArg = args.edits || "";
    if (!pathArg) return "Error: 'path' argument is required for batch_edit.";
    if (!editsArg) return "Error: 'edits' argument is required for batch_edit.";
    const filePath = resolve(projectRoot, pathArg);
    if (!existsSync(filePath)) {
      return `Error: File not found at path "${pathArg}"`;
    }
    
    let editList: { search: string; replace: string }[];
    try {
      editList = JSON.parse(editsArg);
      if (!Array.isArray(editList)) {
        return "Error: 'edits' argument must be a JSON array of search/replace objects.";
      }
    } catch (err: any) {
      return `Error parsing edits JSON: ${err.message || String(err)}`;
    }

    const confined = pathConfinementError(projectRoot, filePath, `batch_edit path "${pathArg}"`);
    if (confined) return confined;
    try {
      const originalContent = readFileSync(filePath, "utf8");
      let currentContent = originalContent;

      for (let idx = 0; idx < editList.length; idx++) {
        const edit = editList[idx]!;
        if (edit.search === undefined || edit.replace === undefined) {
          return `Error: Edit at index ${idx} is missing 'search' or 'replace' properties.`;
        }
        if (!currentContent.includes(edit.search)) {
          return `Error: Search block at index ${idx} not found exactly in "${pathArg}". Aborting all batch edits. No changes written. ${diagnoseEditMismatch(currentContent, edit.search)}`;
        }
        // Function replacement → literal insertion (no `$$`/`$&`/`` $` ``/`$'`
        // expansion that would corrupt content containing those sequences).
        currentContent = currentContent.replace(edit.search, () => edit.replace);
      }

      writeFileSync(filePath, currentContent, "utf8");
      return `Success: Applied ${editList.length} edits successfully to "${pathArg}"`;
    } catch (err: any) {
      return `Error applying batch_edit: ${err.message || String(err)}`;
    }
  }
});

// 15. git_summary
registry.register({
  name: "git_summary",
  description: "Get structured summary of the current Git repository status (active branch, dirty files, recent commits).",
  category: "read",
  schema: z.object({}),
  execute: async (_args: any, context: any) => {
    const { projectRoot } = context;
    try {
      const { getGitSummary } = await import("../git/intelligence.js");
      const summary = await getGitSummary(projectRoot);
      return [
        `Branch: ${summary.branch}`,
        `Working Tree: ${summary.isClean ? "Clean" : "Dirty"}`,
        `Staged Files: ${summary.staged}`,
        `Unstaged Files: ${summary.unstaged}`,
        `Untracked Files: ${summary.untracked}`,
        `Recent Commits:`,
        summary.recentCommits.map(c => `  - [${c.hash}] ${c.subject}`).join("\n"),
        `GitHub CLI (gh) Available: ${summary.ghAvailable ? "Yes" : "No"}`
      ].join("\n");
    } catch (err: any) {
      return `Error fetching Git summary: ${err.message || String(err)}`;
    }
  }
});

// 16. git_diff
registry.register({
  name: "git_diff",
  description: "Get diff of unstaged changes, or staged changes in the workspace.",
  category: "read",
  schema: z.object({
    staged: z.union([z.boolean(), z.string()]).optional(),
  }),
  execute: async (args: any, context: any) => {
    const { projectRoot } = context;
    const isStaged = args.staged === true || args.staged === "true";
    try {
      const { execa } = await import("execa");
      const gitOpts = { cwd: projectRoot, reject: false } as const;
      const cmdArgs = ["diff"];
      if (isStaged) {
        cmdArgs.push("--staged");
      }
      const res = await execa("git", cmdArgs, gitOpts);
      if (res.exitCode !== 0) {
        return `Error running git diff: ${res.stderr}`;
      }
      return res.stdout || "No changes detected.";
    } catch (err: any) {
      return `Error running git diff: ${err.message || String(err)}`;
    }
  }
});


/**
 * Executes a single tool call and returns the string result.
 * Includes retry logic with exponential backoff for transient failures.
 * Includes circuit breaker to prevent infinite loops.
 */
export async function executeTool(
  name: string,
  args: Record<string, string>,
  projectRoot: string,
  skillsRoot?: string,
  signal?: AbortSignal,
  breaker?: CircuitBreakerState
): Promise<string> {
  // Use the caller's per-turn breaker when provided (scoped path), else the
  // process-wide fallback (legacy). Either way the trip reason is latched on the
  // state so the owning turn loop can hard-break (see consumeBreakerTrip).
  const state = breaker ?? circuitBreakerState;
  // Check circuit breaker before execution
  const circuitCheck = checkCircuitBreaker(state, [{ name, arguments: args }]);
  if (circuitCheck.shouldBreak) {
    state.trippedReason = circuitCheck.reason ?? "Possible infinite loop detected.";
    return `Error: Circuit breaker triggered - ${circuitCheck.reason}`;
  }

  const resolvedSkillsRoot = skillsRoot || resolveSkillsRoot();

  const executeOnce = async (): Promise<string> => {
    const mockContext = {
      sessionId: "session-id",
      traceId: "trace-id",
      workspaceId: "workspace-id",
      cancellationToken: signal || { aborted: false },
      governanceContext: {
        tokenBudgetLimit: 100000,
        tokensConsumed: 0,
        costCeilingUsd: 10.0,
        costConsumedUsd: 0.0,
        maxAttemptsLimit: 3,
      },
      retrievalScope: [],
      schedulerScope: [],
      sandboxScope: "native",
      projectRoot,
      skillsRoot: resolvedSkillsRoot,
    };
    try {
      const res = await registry.invoke(name, args, mockContext as any);
      return typeof res === "string" ? res : String(res);
    } catch (err: any) {
      const msg = err.message || String(err);
      if (msg.includes("is not registered")) {
        return "Error: Unknown tool";
      }
      return `Error: ${msg}`;
    }
  };

  try {
    const result = await executeWithRetry(name, executeOnce);
    // A tool that returns an `Error…` string (the convention for handler failures
    // AND for a hard-refused command, e.g. a self-terminating shell command) has
    // NOT succeeded — count it toward the breaker so the model can't churn on a
    // command that will always be refused. Previously every non-throwing result
    // was recorded as success, so the consecutive-failure breaker never tripped
    // and a blocked command (taskkill /IM node.exe …) looped until maxLoops.
    //
    // command/dispatch tools report failure as `Exit Code: <nonzero>` (a
    // non-`Error:` string), so a failing build (`execute_command`) or a failing
    // subagent (`dispatch_subagent`) used to RESET the failure counter — the
    // breaker never tripped and the model spun re-running a build that always
    // fails. When `breakerFailedExits` is on, a non-zero exit counts as a failure.
    const isError = /^Error[:\s]/.test(result);
    const isFailedExit =
      getRuntimeFlags().breakerFailedExits && /^Exit Code:\s*[1-9]/.test(result);
    if (isError || isFailedExit) {
      recordToolFailure(state);
    } else {
      recordToolSuccess(state);
    }
    return result;
  } catch (error) {
    // Record failure for circuit breaker
    recordToolFailure(state);
    throw error;
  }
}

/** Reset the process-wide fallback circuit breaker (the legacy path). Called at
 *  the start of each chat turn so a fresh turn isn't pre-tripped by a previous
 *  turn's failures/repeats. The scoped path uses a fresh per-turn breaker
 *  instead, so it never needs this. */
export function resetToolCircuitBreaker(): void {
  resetCircuitBreaker(circuitBreakerState);
}

/** Create a fresh per-turn circuit breaker for the scoped path so the main turn
 *  and each subagent (incl. parallel) get isolated breaker state. */
export function createTurnCircuitBreaker(): CircuitBreakerState {
  return createCircuitBreaker();
}

/**
 * Read-and-clear the process-wide fallback breaker's trip reason (legacy path),
 * or `null` if it hasn't tripped since the last read/reset. A non-null result
 * means a tool was short-circuited by the breaker (the model is churning on
 * identical or always-failing calls), so the loop should stop and surface a
 * final message rather than feed the model an error it keeps ignoring until
 * maxLoops. The scoped path reads its own breaker via `consumeBreakerTrip`.
 */
export function consumeCircuitBreakerTrip(): string | null {
  return consumeBreakerTrip(circuitBreakerState);
}

const MAX_TOOL_RESULT_CHARS = 30_000; // ~7,500 tokens
const MAX_TOOL_RESULT_LINES = 500;

/**
 * A command-style tool result whose actionable part (compiler/test errors, the
 * exit summary) is at the END rather than the head. `execute_command` formats
 * its result as `Exit Code: …\nStdout:\n…\nStderr:\n…`, so the verdict — stderr
 * and the tail of stdout — lands at the bottom. Detect by the canonical name OR
 * that stable header, so an alias the model invented for the command tool still
 * benefits.
 */
function isTailRelevantToolResult(name: string, result: string): boolean {
  return name === "execute_command" || result.startsWith("Exit Code: ");
}

export function truncateToolResult(name: string, result: string, modelName?: string): string {
  let maxChars = MAX_TOOL_RESULT_CHARS;
  let maxLines = MAX_TOOL_RESULT_LINES;

  if (modelName) {
    try {
      // Was `require("@agency/providers")` — but this module is ESM, so `require`
      // is undefined and threw, silently falling back to the default for EVERY
      // model: the "scales by context window" behaviour never actually ran. A
      // small-context model (≤16K) was handed the full ~30K-char (~7.5K token)
      // result, risking the very overflow the cap exists to prevent (§8 family).
      const spec = getModelSpec(modelName);
      if (spec && spec.contextWindow) {
        const context = spec.contextWindow;
        if (context < 32000) {
          // Small window (≤16K — note many "16k" models report 16385): cap hard
          // so one tool result can't overflow it. `<= 16384` used to miss the
          // common 16385 models, leaving them on the medium cap.
          maxChars = 8000;   // ~2K tokens
          maxLines = 150;
        } else if (context >= 200000) {
          // Large window: a bit more headroom, but deliberately NOT the old
          // 400K-char (~100K token) dump — that wasted half the window on a
          // single result. The truncation note tells the model to fetch more via
          // read_file ranges, so a lean cap keeps tokens low without losing
          // reachable detail (token efficiency the user asked for).
          maxChars = 48000;  // ~12K tokens
          maxLines = 800;
        } else {
          // Medium window (32K–128K): the lean default.
          maxChars = 32000;  // ~8K tokens
          maxLines = 500;
        }
      }
    } catch {
      // safe fallback if the spec lookup fails
    }
  }

  if (result.length <= maxChars) return result;

  // For command-style output the verdict (compiler/test errors, exit summary) is
  // at the tail; head-only truncation would hide exactly what the model needs to
  // diagnose a failure, so it churns blind. Keep head+tail when the flag is on.
  // Off → legacy head-only (byte-identical). Other tools stay head-only either way.
  const keepTail = getRuntimeFlags().toolResultTailKept && isTailRelevantToolResult(name, result);

  const lines = result.split("\n");
  if (lines.length > maxLines) {
    if (keepTail) {
      const headLines = Math.max(1, Math.floor(maxLines * 0.4));
      const tailLines = maxLines - headLines;
      const omitted = lines.length - headLines - tailLines;
      return (
        lines.slice(0, headLines).join("\n") +
        `\n\n... [truncated: ${omitted} middle lines. Use read_file with start_line/end_line to view specific ranges.]\n\n` +
        lines.slice(lines.length - tailLines).join("\n")
      );
    }
    const kept = lines.slice(0, maxLines);
    return kept.join("\n") + `\n\n... [truncated: ${lines.length - maxLines} more lines. Use read_file with start_line/end_line to view specific ranges.]`;
  }
  if (keepTail) {
    const headChars = Math.max(1, Math.floor(maxChars * 0.4));
    const tailChars = maxChars - headChars;
    const omitted = result.length - headChars - tailChars;
    return (
      result.slice(0, headChars) +
      `\n... [truncated: ${omitted} middle characters]\n` +
      result.slice(result.length - tailChars)
    );
  }
  return result.slice(0, maxChars) + `\n... [truncated: ${result.length - maxChars} more characters]`;
}
