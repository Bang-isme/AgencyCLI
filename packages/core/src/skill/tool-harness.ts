import { existsSync, readFileSync, writeFileSync, appendFileSync, readdirSync, unlinkSync, renameSync, statSync, mkdirSync } from "node:fs";
import {
  replaceFunctionBody,
  replaceMethodBody,
  renameSymbol,
  modifyImport,
  deleteNode,
  insertFunction,
} from "../utils/ast-compiler.js";
import { resolve, join, relative } from "node:path";
import { runShellCommand } from "../terminal/sandbox.js";
import { dispatchAgent } from "../agents/orchestrator.js";
import { resolveSkillsRoot } from "../skills-root.js";
import { loadIgnoreFilter } from "../index/gitignore-parser.js";
import { createCircuitBreaker, checkCircuitBreaker, recordToolSuccess, recordToolFailure } from "../chat/circuit-breaker.js";
import { z } from "zod";
import { getModelSpec } from "@agency/providers";
import { ToolRegistry } from "@agency/tooling";
import { ApprovalPolicyEngine, ApprovalRequiredError } from "../approval/index.js";
import { EventBus } from "../events/event-bus.js";
import { emitThought } from "../events/cognition.js";
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
 */
export function parseToolCalls(text: string): ToolCall[] {
  const toolCalls: ToolCall[] = [];
  const regex = /<(tool_call|invoke|invoke_call)\s+name="([^"]+)">([\s\S]*?)<\/(tool_call|invoke|invoke_call)>/g;
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
 * Circuit breaker state to prevent infinite loops and cascading failures
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
    // Narrate the safety decision to the cognition panel (no-op unless the
    // cognitionStream flag is on). Separate channel from approval:warn above —
    // that drives the audit flow, this narrates the agent's reasoning.
    emitThought({
      source: "risk-engine",
      phase: "editing",
      severity: "adaptation",
      message: `Safety: would gate ${action} (risk ${evaluation.risk.level}) — ${evaluation.reason}`,
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
  emitThought({
    source: "risk-engine",
    phase: "editing",
    severity: "warning",
    message: `Safety: blocked ${action} (risk ${evaluation.risk.level}) — ${evaluation.reason}`,
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
        const startLine = Math.max(1, parseInt(String(startLineRaw) || "1", 10));
        const endLine = Math.min(totalLines, parseInt(String(endLineRaw) || String(totalLines), 10));
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
    try {
      writeFileSync(filePath, contentArg, "utf8");
      return `Success: File written successfully to "${pathArg}" (${contentArg.length} characters)`;
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
    try {
      const existedBefore = existsSync(filePath);
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
    try {
      const currentContent = readFileSync(filePath, "utf8");
      if (!currentContent.includes(searchArg)) {
        return `Error: Search block not found exactly in "${pathArg}". Make sure whitespace, newlines, and content match exactly.`;
      }
      const newContent = currentContent.replace(searchArg, replaceArg);
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
    "Precise TypeScript/JavaScript structural edit via the AST — more reliable than edit_file's text search/replace for renames and whole-body swaps. operation: rename_symbol (target=old name, replacement=new name) | replace_function_body (target=fn name, replacement=new body) | replace_method_body (className + target=method, replacement=new body) | modify_import (target=module, addImports/removeImports=comma-separated) | delete_node (target=fn/class/var name) | insert_function (replacement=full function code).",
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
  description: "Search for a regex pattern inside a file and return matching lines.",
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
              const simplePattern = patternArg.replace(/\*\*/g, "").replace(/\*/g, "");
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
      return `Found ${results.length} files:\n${results.slice(0, 200).join("\n")}`;
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
    try {
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
  description: "Search for a pattern across multiple files in the workspace recursively.",
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
      return `Found ${results.length} match(es) in "${basePath}":\n${results.join("\n")}`;
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

    try {
      const originalContent = readFileSync(filePath, "utf8");
      let currentContent = originalContent;

      for (let idx = 0; idx < editList.length; idx++) {
        const edit = editList[idx]!;
        if (edit.search === undefined || edit.replace === undefined) {
          return `Error: Edit at index ${idx} is missing 'search' or 'replace' properties.`;
        }
        if (!currentContent.includes(edit.search)) {
          return `Error: Search block at index ${idx} not found exactly in "${pathArg}". Aborting all batch edits. No changes written.`;
        }
        currentContent = currentContent.replace(edit.search, edit.replace);
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
  signal?: AbortSignal
): Promise<string> {
  // Check circuit breaker before execution
  const circuitCheck = checkCircuitBreaker(circuitBreakerState, [{ name, arguments: args }]);
  if (circuitCheck.shouldBreak) {
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
    // Record success if no error
    recordToolSuccess(circuitBreakerState);
    return result;
  } catch (error) {
    // Record failure for circuit breaker
    recordToolFailure(circuitBreakerState);
    throw error;
  }
}

const MAX_TOOL_RESULT_CHARS = 30_000; // ~7,500 tokens
const MAX_TOOL_RESULT_LINES = 500;

export function truncateToolResult(_name: string, result: string, modelName?: string): string {
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
  const lines = result.split("\n");
  if (lines.length > maxLines) {
    const kept = lines.slice(0, maxLines);
    return kept.join("\n") + `\n\n... [truncated: ${lines.length - maxLines} more lines. Use read_file with start_line/end_line to view specific ranges.]`;
  }
  return result.slice(0, maxChars) + `\n... [truncated: ${result.length - maxChars} more characters]`;
}
