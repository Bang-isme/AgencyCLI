import { execa } from "execa";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { ApprovalRequiredError } from "../approval/policy.js";

export const COMPACT_SCRIPT =
  "codex-project-memory/scripts/compact_context.py";

export interface CompactContextOptions {
  dryRun?: boolean;
  maxAgeDays?: number;
  keepLatest?: number;
  yes?: boolean;
}

export interface CompactContextResult {
  exitCode: number;
  stdout: string;
  bytesSaved?: number;
}

/** Parse `bytes_freed` from compact_context.py JSON stdout. */
export function parseCompactBytesSaved(stdout: string): number | undefined {
  const trimmed = stdout.trim();
  if (!trimmed) return undefined;
  try {
    const payload = JSON.parse(trimmed) as { bytes_freed?: unknown };
    if (typeof payload.bytes_freed === "number" && payload.bytes_freed >= 0) {
      return payload.bytes_freed;
    }
  } catch {
    const match = trimmed.match(/"bytes_freed"\s*:\s*(\d+)/);
    if (match) return Number.parseInt(match[1]!, 10);
  }
  return undefined;
}

/** Sum on-disk sizes of session/feedback markdown under `.agency/` and `.codex/`. */
export function measureCodexMemoryBytes(projectRoot: string): number {
  let total = 0;
  for (const rootFolder of [".agency", ".codex"]) {
    for (const subdir of ["sessions", "feedback"]) {
      const dir = join(projectRoot, rootFolder, subdir);
      let entries: string[];
      try {
        entries = readdirSync(dir);
      } catch {
        continue;
      }
      for (const name of entries) {
        if (!name.endsWith(".md")) continue;
        const path = join(dir, name);
        try {
          const stat = statSync(path);
          if (stat.isFile()) total += stat.size;
        } catch {
          // skip unreadable files
        }
      }
    }
  }
  return total;
}

export async function compactContext(
  skillsRoot: string,
  projectRoot: string,
  opts: CompactContextOptions = {}
): Promise<CompactContextResult> {
  if (!opts.dryRun && !opts.yes) {
    throw new ApprovalRequiredError(
      "compact requires approval (--yes or TUI confirm)"
    );
  }

  const argv = ["--project-root", projectRoot];
  if (opts.dryRun) argv.push("--dry-run");
  if (opts.maxAgeDays !== undefined) {
    argv.push("--max-age-days", String(opts.maxAgeDays));
  }
  if (opts.keepLatest !== undefined) {
    argv.push("--keep-latest", String(opts.keepLatest));
  }

  const script = join(skillsRoot, COMPACT_SCRIPT);
  const beforeBytes = opts.dryRun ? measureCodexMemoryBytes(projectRoot) : undefined;

  const result = await execa("python", [script, ...argv], { reject: false });
  const exitCode = result.exitCode ?? 1;
  const stdout = result.stdout;

  let bytesSaved = parseCompactBytesSaved(stdout);
  if (bytesSaved === undefined && opts.dryRun && beforeBytes !== undefined) {
    const afterBytes = measureCodexMemoryBytes(projectRoot);
    if (afterBytes < beforeBytes) bytesSaved = beforeBytes - afterBytes;
  }

  return { exitCode, stdout, bytesSaved };
}
