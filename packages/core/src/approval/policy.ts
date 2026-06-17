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

  // 1. Matches any command containing both a process-killing verb and the word "node" in any order (e.g. "kill node", "gps node | spps")
  const hasKillVerb = /\b(kill|taskkill|stop-process|spps|pkill|killall|terminate)\b/i.test(normalized);
  const hasNode = /\bnode(\.exe)?\b/i.test(normalized);
  if (hasKillVerb && hasNode) {
    return true;
  }

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

  // 2. Matches killing current process PID or parent PID dynamically in any order
  const pid = process.pid;
  const ppid = process.ppid;
  if (pid || ppid) {
    const targets = [pid, ppid].filter(Boolean);
    const hasTargetPid = targets.some(t => new RegExp(`\\b${t}\\b`).test(normalized));
    const hasKillVerb = /\b(kill|taskkill|stop-process|spps|pkill|killall|terminate)\b/i.test(normalized);
    if (hasTargetPid && hasKillVerb) {
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
