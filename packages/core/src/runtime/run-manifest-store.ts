import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sanitizeLifecycleEvent, type ActionLifecycleEvent } from "../product/action-lifecycle.js";

export const MAX_RUN_MANIFESTS = 20;
export const MAX_MANIFEST_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export interface RunManifestPolicySummary {
  memoryState?: string;
  contextState?: string;
  executionState?: string;
  verificationState?: string;
  integrationsState?: string;
}

export interface RunManifestReceipts {
  memoryIds?: string[];
  contextFiles?: string[];
  verificationGates?: string[];
}

export interface RunManifest {
  runId: string;
  sessionId?: string;
  startedAt: number;
  updatedAt: number;
  status: "queued" | "running" | "succeeded" | "failed" | "incomplete" | "cancelled";
  summary: string;
  policySummary?: RunManifestPolicySummary;
  eventCount: number;
  modifiedFiles: string[];
  lifecycleEvents: ActionLifecycleEvent[];
  receipts?: RunManifestReceipts;
}

export function resolveRunsDir(projectRoot: string): string {
  return join(projectRoot, ".agency", "runs");
}

export function sanitizeRunManifest(manifest: RunManifest): RunManifest {
  const sanitizedEvents = (manifest.lifecycleEvents || []).map(sanitizeLifecycleEvent);
  const modifiedFiles = Array.from(new Set((manifest.modifiedFiles || []).filter((f) => Boolean(f) && typeof f === "string")));

  let summary = manifest.summary ? manifest.summary.slice(0, 1024) : "Run execution summary";
  summary = summary.replace(/\b(?:sk-[a-zA-Z0-9_-]{20,}|AIza[a-zA-Z0-9_-]{35}|gsk_[a-zA-Z0-9_-]{20,}|Bearer\s+[a-zA-Z0-9._-]{20,})\b/g, "[REDACTED_SECRET]");
  summary = summary.replace(/((?:api_key|password|secret|auth_token)\s*[:=]\s*["'])[^"']+(["'])/gi, "$1[REDACTED]$2");

  return {
    ...manifest,
    summary,
    modifiedFiles,
    lifecycleEvents: sanitizedEvents,
  };
}

/**
 * Enforces retention policies on `.agency/runs`:
 * - Deletes manifests older than 30 days.
 * - Caps total runs to the latest 20.
 */
export function enforceRunRetention(runsDir: string, now = Date.now()): void {
  if (!existsSync(runsDir)) return;
  try {
    const files = readdirSync(runsDir)
      .filter((f) => f.endsWith(".json") && !f.includes(".tmp"))
      .map((name) => {
        const fullPath = join(runsDir, name);
        try {
          const st = statSync(fullPath);
          return { name, path: fullPath, mtimeMs: st.mtimeMs };
        } catch {
          return null;
        }
      })
      .filter((item): item is { name: string; path: string; mtimeMs: number } => item !== null);

    // Delete files older than MAX_MANIFEST_AGE_MS
    for (const file of files) {
      if (now - file.mtimeMs > MAX_MANIFEST_AGE_MS) {
        try {
          unlinkSync(file.path);
        } catch {}
      }
    }

    // Refresh list after age deletion
    const remaining = readdirSync(runsDir)
      .filter((f) => f.endsWith(".json") && !f.includes(".tmp"))
      .map((name) => {
        const fullPath = join(runsDir, name);
        try {
          return { path: fullPath, mtimeMs: statSync(fullPath).mtimeMs };
        } catch {
          return null;
        }
      })
      .filter((item): item is { path: string; mtimeMs: number } => item !== null)
      .sort((a, b) => b.mtimeMs - a.mtimeMs);

    // If total exceeds MAX_RUN_MANIFESTS, delete oldest excess files
    if (remaining.length > MAX_RUN_MANIFESTS) {
      const toDelete = remaining.slice(MAX_RUN_MANIFESTS);
      for (const file of toDelete) {
        try {
          unlinkSync(file.path);
        } catch {}
      }
    }
  } catch {}
}

/**
 * Saves a compact, sanitized RunManifest atomically to `.agency/runs/<runId>.json`.
 */
export function saveRunManifest(projectRoot: string, manifest: RunManifest): void {
  const runsDir = resolveRunsDir(projectRoot);
  mkdirSync(runsDir, { recursive: true });

  const sanitized = sanitizeRunManifest(manifest);
  const targetPath = join(runsDir, `${sanitized.runId}.json`);
  const tmpPath = join(runsDir, `${sanitized.runId}.json.tmp.${Date.now()}.${Math.random().toString(36).slice(2, 6)}`);

  const payload = JSON.stringify(sanitized, null, 2);
  writeFileSync(tmpPath, payload, "utf8");
  renameSync(tmpPath, targetPath);

  enforceRunRetention(runsDir);
}

/**
 * Loads a specific RunManifest by runId.
 */
export function loadRunManifest(projectRoot: string, runId: string): RunManifest | null {
  const targetPath = join(resolveRunsDir(projectRoot), `${runId}.json`);
  if (!existsSync(targetPath)) return null;
  try {
    const raw = readFileSync(targetPath, "utf8");
    return JSON.parse(raw) as RunManifest;
  } catch {
    return null;
  }
}

/**
 * Lists all persisted RunManifests sorted by updatedAt descending.
 */
export function listRunManifests(projectRoot: string): RunManifest[] {
  const runsDir = resolveRunsDir(projectRoot);
  if (!existsSync(runsDir)) return [];
  try {
    const files = readdirSync(runsDir).filter((f) => f.endsWith(".json") && !f.includes(".tmp"));
    const manifests: RunManifest[] = [];
    for (const f of files) {
      try {
        const raw = readFileSync(join(runsDir, f), "utf8");
        manifests.push(JSON.parse(raw));
      } catch {}
    }
    return manifests.sort((a, b) => b.updatedAt - a.updatedAt);
  } catch {
    return [];
  }
}
