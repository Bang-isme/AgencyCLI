/** Destructive shell command patterns (deny-by-default without approval). */
export const DENY_PATTERNS: RegExp[] = [
  /\brm\s+(-\w+\s+)*-rf\b/i,
  /\bformat\b/i,
  /\bdiskpart\b/i,
  /\bdel\s+\/f\b/i,
  /\bdel\s+\/s\b/i,
  /\brd\s+\/s\b/i,
  /curl[^\n|]*\|[^\n]*\bsh\b/i,
  /wget[^\n|]*\|[^\n]*\bsh\b/i,
  /\bmkfs\b/i,
  /\bdd\s+if=/i,
  /\bshutdown\b/i,
  /\breboot\b/i,
  /\bpoweroff\b/i,
  /\binit\s+0\b/i,
  /\b:\(\)\s*\{\s*:\|\:&\s*\}\s*;\s*:/,
  /\bchmod\s+-R\s+777\s+\/\b/,
  /\bchown\s+-R\b[^\n]*\s+\/\s*$/,
  /\btaskkill\b[^\n]*\bnode(\.exe)?\b/i,
  /\b(killall|pkill)\b[^\n]*\bnode\b/i,
  /\bkill\b[^\n]*\s(0|-1)\b/i,
  /\bStop-Process\b[^\n]*\bnode\b/i,
  /\bspps\b[^\n]*\bnode\b/i,
  /\bwmic\b[^\n]*\bnode\b[^\n]*\b(delete|terminate)\b/i,
];

export function isDestructiveCommand(cmd: string): boolean {
  const normalized = cmd.trim();
  if (!normalized) return false;
  return DENY_PATTERNS.some((pattern) => pattern.test(normalized));
}
