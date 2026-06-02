import type { ThemeTokens } from "../../themes/registry.js";

export function getBadgeStyles(badge: string, theme: ThemeTokens): { bg: string; fg: string; icon: string } {
  const b = badge.trim().toUpperCase();
  switch (b) {
    case "EXPLORE":
      return { bg: theme.highlight, fg: "black", icon: "→" };
    case "READ":
      return { bg: theme.panel, fg: theme.highlight, icon: "→" };
    case "WRITE":
      return { bg: theme.success, fg: "black", icon: "+" };
    case "TODOS":
    case "TODO":
      return { bg: theme.warning, fg: "black", icon: "●" };
    case "ENTER PLAN MODE":
    case "PLAN MODE":
      return { bg: theme.warning, fg: "black", icon: "→" };
    case "GATE":
    case "SYSTEM":
      return { bg: theme.panel, fg: theme.muted, icon: "●" };
    case "DONE":
      return { bg: theme.success, fg: "black", icon: "✓" };
    case "SHELL":
    case "EXECUTE":
      return { bg: theme.accent, fg: "white", icon: "$" };
    default:
      return { bg: theme.panel, fg: theme.text, icon: "→" };
  }
}

export const TOOL_ALIASES: Record<string, string> = {
  execute_command: "exec",
  read_file: "read",
  view_file: "view",
  write_file: "write",
  edit_file: "edit",
  batch_edit: "batch_edit",
  multi_replace_file_content: "replace",
  replace_file_content: "replace",
  grep_search: "grep",
  grep_file: "grep",
  find_files: "find",
  create_directory: "mkdir",
  delete_file: "rm",
  move_file: "mv",
  file_info: "info",
  dispatch_subagent: "subagent",
};

export function getToolAlias(toolName: string): string {
  return TOOL_ALIASES[toolName] || toolName;
}

export function getGroundedTargetName(targetPath: string): string {
  let cleanedPath = targetPath.trim();
  let isCommand = false;

  if (cleanedPath.startsWith("{") && cleanedPath.endsWith("}")) {
    try {
      const parsed = JSON.parse(cleanedPath);
      if (parsed && typeof parsed === "object") {
        if (parsed.command !== undefined) {
          cleanedPath = String(parsed.command).trim();
          isCommand = true;
        } else if (parsed.CommandLine !== undefined) {
          cleanedPath = String(parsed.CommandLine).trim();
          isCommand = true;
        } else if (parsed.path !== undefined) {
          cleanedPath = String(parsed.path).trim();
        } else if (parsed.filePath !== undefined) {
          cleanedPath = String(parsed.filePath).trim();
        } else if (parsed.TargetFile !== undefined) {
          cleanedPath = String(parsed.TargetFile).trim();
        } else if (parsed.AbsolutePath !== undefined) {
          cleanedPath = String(parsed.AbsolutePath).trim();
        } else if (parsed.SearchPath !== undefined) {
          cleanedPath = String(parsed.SearchPath).trim();
        } else if (parsed.DirectoryPath !== undefined) {
          cleanedPath = String(parsed.DirectoryPath).trim();
        } else if (parsed.target !== undefined) {
          cleanedPath = String(parsed.target).trim();
        } else {
          // No recognized path/command field — do NOT guess a target from an
          // arbitrary arg. The old "first string value" fallback grabbed
          // free-text args (e.g. a subagent `task` description) and rendered them
          // as if they were the tool's target → the wrong label seen in the
          // user's screenshot (`list_dir · short video`). Show no target instead.
          cleanedPath = "";
        }
      }
    } catch {}
  }

  // If it is a command string, return it directly to avoid split corruption
  if (isCommand) {
    return cleanedPath;
  }

  // Just the file name. The previous version hardcoded this repo's own file
  // names to grandiose descriptions ("App.tsx" → "main application runtime
  // container", "stream.ts" → "LLM chat streaming orchestrator") and tagged paths
  // with "TUI component: …" / "core orchestrator module: …" prefixes — wrong and
  // pretentious on any OTHER project the agent runs against (a user's own App.tsx
  // is not "the main application runtime container"). Show the real file name.
  return cleanedPath.split(/[\\/]/).pop() || cleanedPath;
}

const PAST_TENSE: Record<string, string> = {
  Run: "Ran",
  Read: "Read",
  Write: "Wrote",
  "Append to": "Appended to",
  Edit: "Edited",
  Search: "Searched",
  Find: "Found",
  List: "Listed",
  Inspect: "Inspected",
  Create: "Created",
  Delete: "Deleted",
  Move: "Moved",
};

/** Present-tense action label → past tense, for a completed step ("Read x" →
 *  "Read x", "Run x" → "Ran x"). Matches the leading verb word; leaves anything
 *  unrecognized (e.g. "Delegate to subagent") untouched. */
export function toPastTense(phrase: string): string {
  // Try the longest verb keys first so "Append to" beats a bare "Append".
  for (const verb of Object.keys(PAST_TENSE).sort((a, b) => b.length - a.length)) {
    if (phrase === verb || phrase.startsWith(verb + " ")) {
      return PAST_TENSE[verb] + phrase.slice(verb.length);
    }
  }
  return phrase;
}

export function translateSubLineLabel(label: string): string {
  const match = label.match(/^([a-zA-Z0-9_-]+):\s*(.*)$/);
  if (match) {
    const toolName = match[1]!;
    const args = match[2] || "";
    // If it contains lines range, keep it for context in advanced/expert modes
    const linesMatch = args.match(/\(lines\s+\d+-\d+\)/) || args.match(/\(chunks\s+at\s+lines\s+.*\)/);
    const range = linesMatch ? ` ${linesMatch[0]}` : "";

    // Remove lines range suffix to translate pure path
    const cleanArgs = args.replace(/\(lines\s+\d+-\d+\)/, "").replace(/\(chunks\s+at\s+lines\s+.*\)/, "").trim();
    return getSemanticToolOperation(toolName, "", cleanArgs) + range;
  }
  return label;
}

export function getSemanticToolOperation(toolName: string, argsStr: string, target?: string): string {
  let displayTarget = "";
  let rawPath = "";
  let command = "";

  if (target) {
    rawPath = target;
  } else if (argsStr) {
    try {
      const parsed = JSON.parse(argsStr);
      rawPath = parsed.path || parsed.TargetFile || parsed.SearchPath || parsed.DirectoryPath || parsed.AbsolutePath || "";
      command = parsed.command || parsed.CommandLine || "";
    } catch { }
  }

  if (rawPath) {
    displayTarget = getGroundedTargetName(rawPath);
  } else if (command) {
    // The real command (truncated), not "validation suite via npm" — not every
    // shell call is a test run.
    displayTarget = command.length > 48 ? command.slice(0, 48) + "…" : command;
  }

  // Plain, accurate verbs (mirrors opencode) instead of flowery, often-wrong
  // phrasing ("Synthesizing X components" for a write, "Acquiring file context"
  // for a read). A reader should see exactly what happened.
  const withTarget = (verb: string, fallback: string) =>
    displayTarget ? `${verb} ${displayTarget}` : fallback;

  const cleanTool = toolName.toLowerCase();
  switch (cleanTool) {
    case "execute_command":
    case "run_command":
      return withTarget("Run", "Run command");
    case "read_file":
    case "view_file":
      return withTarget("Read", "Read file");
    case "write_file":
    case "write_to_file":
      return withTarget("Write", "Write file");
    case "append_file":
      return withTarget("Append to", "Append to file");
    case "edit_file":
    case "ast_edit":
    case "batch_edit":
    case "replace_file_content":
    case "multi_replace_file_content":
      return withTarget("Edit", "Edit file");
    case "grep_search":
    case "grep_file":
      return withTarget("Search", "Search files");
    case "find_files":
      return withTarget("Find", "Find files");
    case "list_dir":
      return withTarget("List", "List directory");
    case "file_info":
      return withTarget("Inspect", "File info");
    case "create_directory":
      return withTarget("Create", "Create directory");
    case "delete_file":
      return withTarget("Delete", "Delete file");
    case "move_file":
      return withTarget("Move", "Move file");
    case "dispatch_subagent":
      return "Delegate to subagent";
    default: {
      const alias = getToolAlias(toolName);
      return displayTarget ? `${alias} ${displayTarget}` : alias;
    }
  }
}
