import { execSync } from "node:child_process";
import { platform } from "node:os";

/**
 * Cross-platform OS clipboard access for the TUI. The READ side was previously
 * inlined in McpOverlay (`getClipboardText`); it lives here now so the new WRITE
 * side (copy a focused turn, P4) shares one platform table instead of a second
 * divergent copy. The command selection is split into pure builders so the
 * platform mapping is unit-testable without spawning a process.
 */

export interface ClipboardCommand {
  cmd: string;
  /** Used when the primary command is unavailable (Linux X11 ↔ Wayland). */
  fallback?: string;
}

/** Shell command that prints the OS clipboard to stdout. */
export function clipboardReadCommand(os: NodeJS.Platform = platform()): ClipboardCommand {
  if (os === "win32") return { cmd: 'powershell -NoProfile -Command "Get-Clipboard"' };
  if (os === "darwin") return { cmd: "pbpaste" };
  return { cmd: "xclip -selection clipboard -o", fallback: "wl-paste" };
}

/** Shell command that writes its stdin to the OS clipboard. */
export function clipboardWriteCommand(os: NodeJS.Platform = platform()): ClipboardCommand {
  if (os === "win32") return { cmd: "clip" };
  if (os === "darwin") return { cmd: "pbcopy" };
  return { cmd: "xclip -selection clipboard", fallback: "wl-copy" };
}

/** Read the OS clipboard. Returns "" on any failure (never throws). */
export function readClipboard(): string {
  const { cmd, fallback } = clipboardReadCommand();
  const run = (c: string) =>
    execSync(c, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  try {
    return run(cmd);
  } catch {
    if (!fallback) return "";
    try {
      return run(fallback);
    } catch {
      return "";
    }
  }
}

/** Write `text` to the OS clipboard via the tool's stdin. Returns false on failure. */
export function writeClipboard(text: string): boolean {
  const { cmd, fallback } = clipboardWriteCommand();
  const run = (c: string) => {
    execSync(c, { input: text, stdio: ["pipe", "ignore", "ignore"] });
  };
  try {
    run(cmd);
    return true;
  } catch {
    if (!fallback) return false;
    try {
      run(fallback);
      return true;
    } catch {
      return false;
    }
  }
}
