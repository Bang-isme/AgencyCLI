import { readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * Lightweight workspace edit-detection for the main-turn verify loop.
 *
 * We only need a boolean "did this chat turn change any source file" so a pure
 * Q&A turn (no edits) skips the (expensive) acceptance + self-heal pass. A
 * mtime+size signature per non-ignored file is enough to catch creates, deletes,
 * and content edits without hashing file bodies. The walk is bounded (skips heavy
 * dirs, caps depth and file count) so it never stalls a large repo.
 */

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".agency",
  "dist",
  "build",
  "out",
  ".next",
  ".turbo",
  "coverage",
  ".cache",
]);

const MAX_DEPTH = 12;
const MAX_FILES = 20_000;

export type WorkspaceSnapshot = Map<string, string>;

/** Capture a {relPath → "mtimeMs:size"} signature of the workspace's files. */
export function snapshotWorkspace(projectRoot: string): WorkspaceSnapshot {
  const snap: WorkspaceSnapshot = new Map();
  const walk = (dir: string, depth: number): void => {
    if (depth > MAX_DEPTH || snap.size >= MAX_FILES) return;
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (snap.size >= MAX_FILES) return;
      if (entry.name.startsWith(".") && entry.isDirectory() && SKIP_DIRS.has(entry.name)) continue;
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        walk(join(dir, entry.name), depth + 1);
      } else if (entry.isFile()) {
        const full = join(dir, entry.name);
        try {
          const st = statSync(full);
          snap.set(relative(projectRoot, full), `${st.mtimeMs}:${st.size}`);
        } catch {
          // unreadable file → ignore
        }
      }
    }
  };
  walk(projectRoot, 0);
  return snap;
}

/**
 * True if the workspace differs from `before` (any file added, removed, or whose
 * mtime/size changed). Used to decide whether a turn actually edited anything.
 */
export function workspaceChangedSince(projectRoot: string, before: WorkspaceSnapshot): boolean {
  const after = snapshotWorkspace(projectRoot);
  if (after.size !== before.size) return true;
  for (const [path, sig] of after) {
    if (before.get(path) !== sig) return true;
  }
  return false;
}
