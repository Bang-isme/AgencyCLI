import { isDestructiveCommand } from "./patterns.js";

export class ApprovalRequiredError extends Error {
  override readonly name = "ApprovalRequiredError";

  constructor(message: string) {
    super(message);
  }
}

export function isSelfKillingCommand(cmd: string): boolean {
  const normalized = cmd.trim();
  if (!normalized) return false;

  // 1. Matches node-killing commands which would terminate the TUI process image
  const nodeKillPatterns = [
    /\btaskkill\b[^\n]*\bnode(\.exe)?\b/i,
    /\b(killall|pkill)\b[^\n]*\bnode\b/i,
    /\bkill\b[^\n]*\s(0|-1)\b/i,
    /\bStop-Process\b[^\n]*\bnode\b/i,
    /\bspps\b[^\n]*\bnode\b/i,
    /\bwmic\b[^\n]*\bnode\b[^\n]*\b(delete|terminate)\b/i,
  ];

  if (nodeKillPatterns.some((pattern) => pattern.test(normalized))) {
    return true;
  }

  // 2. Matches killing current process PID or parent PID dynamically
  const pid = process.pid;
  const ppid = process.ppid;
  if (pid || ppid) {
    const targets = [pid, ppid].filter(Boolean).join("|");
    const pidKillRegex = new RegExp(`\\b(kill|taskkill|stop-process|spps|pkill)\\b.*\\b(${targets})\\b`, "i");
    if (pidKillRegex.test(normalized)) {
      return true;
    }
  }

  return false;
}

/** True when a shell command or mutating tool needs explicit approval. */
export function requiresApproval(cmd: string, toolWrites?: boolean): boolean {
  if (toolWrites) return true;
  
  if (isSelfKillingCommand(cmd)) {
    return true;
  }

  return isDestructiveCommand(cmd);
}

export function assertApproval(
  cmd: string,
  opts: { yes?: boolean; toolWrites?: boolean; message?: string } = {}
): void {
  if (!requiresApproval(cmd, opts.toolWrites) || opts.yes) return;
  throw new ApprovalRequiredError(
    opts.message ??
      `Command requires approval (--yes or TUI confirm): ${cmd}`
  );
}
