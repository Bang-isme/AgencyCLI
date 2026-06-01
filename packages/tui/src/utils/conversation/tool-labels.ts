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

  const file = cleanedPath.split(/[\\/]/).pop() || cleanedPath;
  const lower = cleanedPath.toLowerCase();

  if (file === "Conversation.tsx") return "conversation render layout";
  if (file === "App.tsx") return "main application runtime container";
  if (file === "SubagentPanel.tsx") return "subagent progress dashboard";
  if (file === "stream.ts") return "LLM chat streaming orchestrator";
  if (file === "planner-engine.ts") return "orchestration DAG task planner";
  if (file === "tool-harness.ts") return "skill tool execution harness";
  if (file === "Prompt.md") return "user instruction requirements";
  if (file === "package.json") return "package configuration manifest";
  if (file === "tsconfig.json") return "TypeScript compiler settings";

  if (lower.includes("packages/tui")) {
    return `TUI component: ${file}`;
  }
  if (lower.includes("packages/core")) {
    return `core orchestrator module: ${file}`;
  }
  if (lower.includes("packages/providers")) {
    return `LLM API provider layer: ${file}`;
  }

  return file;
}

export function toPastTense(phrase: string): string {
  if (phrase.startsWith("Inspecting ")) return phrase.replace("Inspecting ", "Inspected ");
  if (phrase.startsWith("Reading ")) return phrase.replace("Reading ", "Read ");
  if (phrase.startsWith("Writing ")) return phrase.replace("Writing ", "Wrote ");
  if (phrase.startsWith("Synthesizing ")) return phrase.replace("Synthesizing ", "Synthesized ");
  if (phrase.startsWith("Integrating ")) return phrase.replace("Integrating ", "Integrated ");
  if (phrase.startsWith("Scanning ")) return phrase.replace("Scanning ", "Scanned ");
  if (phrase.startsWith("Executing ")) return phrase.replace("Executing ", "Executed ");
  if (phrase.startsWith("Creating ")) return phrase.replace("Creating ", "Created ");
  if (phrase.startsWith("Removing ")) return phrase.replace("Removing ", "Removed ");
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
    const cmdName = command.split(/\s+/)[0] || command;
    displayTarget = `validation suite via ${cmdName}`;
  }

  const cleanTool = toolName.toLowerCase();
  switch (cleanTool) {
    case "execute_command":
    case "run_command":
      return displayTarget ? `Executing ${displayTarget}` : "Executing shell operation";
    case "read_file":
    case "view_file":
      return displayTarget ? `Inspecting ${displayTarget} structure` : "Acquiring file context";
    case "write_file":
    case "write_to_file":
      return displayTarget ? `Synthesizing ${displayTarget} components` : "Writing workspace files";
    case "edit_file":
    case "replace_file_content":
    case "multi_replace_file_content":
      return displayTarget ? `Integrating changes in ${displayTarget}` : "Integrating workspace changes";
    case "grep_search":
      return displayTarget ? `Scanning ${displayTarget} references` : "Scanning workspace files";
    case "find_files":
      return "Scanning project structure";
    case "create_directory":
      return displayTarget ? `Creating folder: ${displayTarget}` : "Creating directory";
    case "delete_file":
      return displayTarget ? `Removing: ${displayTarget}` : "Removing file";
    case "dispatch_subagent":
      return "Spawning autonomous specialist";
    default: {
      const alias = getToolAlias(toolName);
      return `${alias} ${displayTarget ? `➔ ${displayTarget}` : ""}`.trim();
    }
  }
}
