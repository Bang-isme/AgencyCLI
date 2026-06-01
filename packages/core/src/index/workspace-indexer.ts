import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
  openSync,
  readSync,
  closeSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { join, relative } from "node:path";
import { loadIgnoreFilter, isAlwaysSkipped, IgnoreFilter } from "./gitignore-parser.js";
import { detectLanguage, isBinaryExtension } from "./language-map.js";

/** Default skip dirs (kept for backward compat with sync API) */
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", ".agency"]);

/* ── Types ── */

export interface IndexEntry {
  path: string;
  mtimeMs: number;
  size: number;
  contentHash?: string;
  language?: string;
}

export interface WorkspaceIndex {
  version: 1;
  root: string;
  generatedAt: string;
  files: IndexEntry[];
  stats?: IndexStats;
}

export interface IndexStats {
  totalFiles: number;
  totalSize: number;
  languages: Record<string, number>;
  indexDurationMs: number;
  findings?: {
    endpoints: string[];
  };
}

export interface IndexProgress {
  phase: "scanning" | "hashing" | "writing";
  scannedFiles: number;
  scannedDirs: number;
  currentPath: string;
  elapsedMs: number;
}

export interface IndexOptions {
  onProgress?: (progress: IndexProgress) => void;
  signal?: AbortSignal;
  maxFiles?: number;
  respectGitignore?: boolean;
  contentHash?: boolean;
}

/* ── Helpers ── */

const DEFAULT_MAX_FILES = 100_000;
const HASH_CHUNK_SIZE = 8192; // Hash first 8KB for speed
const BATCH_SIZE = 50; // Dirs per batch before yielding

function toPosixPath(path: string): string {
  return path.replace(/\\/g, "/");
}

/**
 * Fast content hash — xxhash-style using Node's crypto.
 * Hashes only the first 8KB for speed.
 */
function hashFileHead(fullPath: string): string | undefined {
  try {
    const stat = statSync(fullPath);
    const ONE_MB = 1024 * 1024;
    if (stat.size < ONE_MB) {
      const content = readFileSync(fullPath);
      return createHash("sha256").update(content).digest("hex").slice(0, 16);
    } else {
      const fd = openSync(fullPath, "r");
      try {
        const buffer = Buffer.alloc(HASH_CHUNK_SIZE);
        const bytesRead = readSync(fd, buffer, 0, HASH_CHUNK_SIZE, 0);
        const chunk = buffer.subarray(0, bytesRead);
        return createHash("sha256").update(chunk).digest("hex").slice(0, 16);
      } finally {
        closeSync(fd);
      }
    }
  } catch {
    return undefined;
  }
}

function indexPath(projectRoot: string): string {
  const agencyPath = join(projectRoot, ".agency", "index.json");
  if (existsSync(agencyPath)) {
    return agencyPath;
  }
  const codexPath = join(projectRoot, ".codex", "index.json");
  if (existsSync(codexPath)) {
    return codexPath;
  }
  return agencyPath;
}

function indexTmpPath(projectRoot: string): string {
  const activePath = indexPath(projectRoot);
  return activePath + ".tmp";
}

/* ── Sync API (backward compat) ── */

function shouldSkipDir(name: string): boolean {
  return SKIP_DIRS.has(name);
}

function walkDir(root: string, dir: string, files: IndexEntry[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (shouldSkipDir(entry.name)) continue;
      walkDir(root, join(dir, entry.name), files);
    } else if (entry.isFile()) {
      const fullPath = join(dir, entry.name);
      const stat = statSync(fullPath);
      files.push({
        path: toPosixPath(relative(root, fullPath)),
        mtimeMs: stat.mtimeMs,
        size: stat.size,
      });
    }
  }
}

export function buildIndex(projectRoot: string): WorkspaceIndex {
  const files: IndexEntry[] = [];
  if (existsSync(projectRoot)) {
    walkDir(projectRoot, projectRoot, files);
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  return {
    version: 1,
    root: projectRoot,
    generatedAt: new Date().toISOString(),
    files,
  };
}

export function incrementalUpdate(projectRoot: string): WorkspaceIndex {
  const existing = loadIndex(projectRoot);
  const fresh = buildIndex(projectRoot);
  if (!existing) return fresh;

  const existingByPath = new Map(existing.files.map((entry) => [entry.path, entry]));
  const mergedFiles = fresh.files.map((entry) => {
    const prev = existingByPath.get(entry.path);
    if (
      prev &&
      prev.mtimeMs === entry.mtimeMs &&
      prev.size === entry.size
    ) {
      return prev;
    }
    return entry;
  });

  return {
    ...fresh,
    files: mergedFiles,
  };
}

/* ── Async API ── */

/** Yield to event loop to prevent blocking */
function yieldTick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * Async directory walker with batching, .gitignore support, and progress.
 */
async function walkDirAsync(
  root: string,
  dir: string,
  files: IndexEntry[],
  filter: ReturnType<typeof loadIgnoreFilter>,
  opts: Required<Pick<IndexOptions, "maxFiles" | "contentHash">> & {
    onProgress?: IndexOptions["onProgress"];
    signal?: AbortSignal;
    startMs: number;
    scannedDirs: number;
  }
): Promise<number> {
  if (opts.signal?.aborted) return opts.scannedDirs;
  if (files.length >= opts.maxFiles) return opts.scannedDirs;

  let dirCount = opts.scannedDirs;

  let entryNames: { name: string; isDir: boolean; isFile: boolean }[];
  try {
    const dirents = readdirSync(dir, { withFileTypes: true });
    entryNames = dirents.map((d) => ({
      name: String(d.name),
      isDir: d.isDirectory(),
      isFile: d.isFile(),
    }));
  } catch {
    return dirCount; // Permission denied, etc.
  }

  const subdirs: string[] = [];

  for (const entry of entryNames) {
    if (opts.signal?.aborted) break;
    if (files.length >= opts.maxFiles) break;

    const relPath = toPosixPath(relative(root, join(dir, entry.name)));

    if (entry.isDir) {
      // Fast path: always-skip dirs
      if (isAlwaysSkipped(entry.name)) continue;
      // Gitignore check
      if (filter.isIgnored(relPath, true)) continue;
      subdirs.push(join(dir, entry.name));
    } else if (entry.isFile) {
      // Gitignore check
      if (filter.isIgnored(relPath, false)) continue;

      const fullPath = join(dir, entry.name);
      let stat: ReturnType<typeof statSync>;
      try {
        stat = statSync(fullPath);
      } catch {
        continue; // File disappeared
      }

      const indexEntry: IndexEntry = {
        path: relPath,
        mtimeMs: stat.mtimeMs,
        size: stat.size,
        language: detectLanguage(entry.name),
      };

      // Content hash for non-binary, reasonably sized files
      if (
        opts.contentHash &&
        !isBinaryExtension(entry.name) &&
        stat.size > 0 &&
        stat.size < 1_000_000 // Skip files > 1MB
      ) {
        indexEntry.contentHash = hashFileHead(fullPath);
      }

      files.push(indexEntry);

      // Report progress
      opts.onProgress?.({
        phase: files.length < 100 ? "scanning" : "hashing",
        scannedFiles: files.length,
        scannedDirs: dirCount,
        currentPath: relPath,
        elapsedMs: Date.now() - opts.startMs,
      });
    }
  }

  // Process subdirs in batches
  for (let i = 0; i < subdirs.length; i++) {
    if (opts.signal?.aborted) break;
    if (files.length >= opts.maxFiles) break;

    dirCount++;

    // Yield every BATCH_SIZE dirs
    if (dirCount % BATCH_SIZE === 0) {
      await yieldTick();
    }

    dirCount = await walkDirAsync(root, subdirs[i]!, files, filter, {
      ...opts,
      scannedDirs: dirCount,
    });
  }

  return dirCount;
}

/**
 * Build workspace index asynchronously with progress reporting.
 * Supports .gitignore, content hashing, abort signal, and file cap.
 */
export async function buildIndexAsync(
  projectRoot: string,
  opts: IndexOptions = {}
): Promise<WorkspaceIndex> {
  const startMs = Date.now();
  const maxFiles = opts.maxFiles ?? DEFAULT_MAX_FILES;
  const respectGitignore = opts.respectGitignore ?? true;
  const contentHash = opts.contentHash ?? true;
  const filter = respectGitignore
    ? loadIgnoreFilter(projectRoot)
    : new IgnoreFilter();

  const files: IndexEntry[] = [];

  opts.onProgress?.({
    phase: "scanning",
    scannedFiles: 0,
    scannedDirs: 0,
    currentPath: "",
    elapsedMs: 0,
  });

  if (existsSync(projectRoot)) {
    await walkDirAsync(root(projectRoot), projectRoot, files, filter, {
      maxFiles,
      contentHash: contentHash && files.length < 50_000,
      onProgress: opts.onProgress,
      signal: opts.signal,
      startMs,
      scannedDirs: 0,
    });
  }

  files.sort((a, b) => a.path.localeCompare(b.path));

function scanSemanticEndpoints(fullPath: string, relativePath: string): string[] {
  try {
    const ext = relativePath.split(".").pop();
    if (ext !== "ts" && ext !== "tsx" && ext !== "js" && ext !== "jsx") {
      return [];
    }
    const content = readFileSync(fullPath, "utf8");
    const endpoints: string[] = [];
    
    // Check routes like app.get('/...', ...) or router.post('/...', ...)
    const routeRegex = /(?:app|router|route)\.(?:get|post|put|delete|patch)\s*\(\s*['"`]([^'"`]+)/gi;
    let match;
    while ((match = routeRegex.exec(content)) !== null) {
      if (match[1]) {
        endpoints.push(`${relativePath} ➔ ${match[1]}`);
      }
    }
    
    // Check Next.js style exports: export async function GET
    const nextRouteRegex = /export\s+(?:async\s+)?function\s+(GET|POST|PUT|DELETE|PATCH)/g;
    let nextMatch;
    while ((nextMatch = nextRouteRegex.exec(content)) !== null) {
      if (nextMatch[1]) {
        endpoints.push(`${relativePath} ➔ ${nextMatch[1]}()`);
      }
    }
    
    return endpoints.slice(0, 10);
  } catch {
    return [];
  }
}

  // Language stats and context scan
  const languages: Record<string, number> = {};
  let totalSize = 0;
  const endpoints: string[] = [];
  
  for (const f of files) {
    totalSize += f.size;
    if (f.language) {
      languages[f.language] = (languages[f.language] ?? 0) + 1;
    }
    if (f.size < 50_000) {
      const found = scanSemanticEndpoints(join(projectRoot, f.path), f.path);
      if (found.length > 0) {
        endpoints.push(...found);
      }
    }
  }

  const durationMs = Date.now() - startMs;

  opts.onProgress?.({
    phase: "writing",
    scannedFiles: files.length,
    scannedDirs: 0,
    currentPath: ".agency/index.json",
    elapsedMs: durationMs,
  });

  const index: WorkspaceIndex = {
    version: 1,
    root: projectRoot,
    generatedAt: new Date().toISOString(),
    files,
    stats: {
      totalFiles: files.length,
      totalSize,
      languages,
      indexDurationMs: durationMs,
      findings: {
        endpoints: endpoints.slice(0, 50),
      },
    },
  };

  return index;
}

function root(projectRoot: string): string {
  return projectRoot;
}

/**
 * Async incremental update — re-walk the tree (cheap) but only re-hash files
 * whose mtime/size changed, keeping the prior content hash otherwise. Re-walking
 * is what keeps the index FRESH: new files are added, deleted/renamed-away files
 * drop out, and changed files are re-hashed. (A prior "only touch the paths in
 * `changedFiles`" fast-path was removed — it was never wired to any caller, it
 * silently failed to ADD newly-created files since it iterated only the existing
 * entries, and it skipped only the cheap directory walk while the expensive part,
 * hashing, is already incremental here.)
 */
export async function incrementalUpdateAsync(
  projectRoot: string,
  opts: IndexOptions = {}
): Promise<WorkspaceIndex> {
  const existing = loadIndex(projectRoot);

  const fresh = await buildIndexAsync(projectRoot, opts);
  if (!existing) return fresh;

  const existingByPath = new Map(
    existing.files.map((entry) => [entry.path, entry])
  );

  const mergedFiles = fresh.files.map((entry) => {
    const prev = existingByPath.get(entry.path);
    if (
      prev &&
      prev.mtimeMs === entry.mtimeMs &&
      prev.size === entry.size
    ) {
      // Keep previous hash if unchanged
      return { ...entry, contentHash: prev.contentHash ?? entry.contentHash };
    }
    return entry;
  });

  return {
    ...fresh,
    files: mergedFiles,
  };
}

/* ── I/O ── */

/**
 * Atomic write — write to .tmp then rename (crash-safe).
 */
export function writeIndex(projectRoot: string, index: WorkspaceIndex): void {
  const dir = join(projectRoot, ".agency");
  mkdirSync(dir, { recursive: true });
  const tmpPath = indexTmpPath(projectRoot);
  const finalPath = indexPath(projectRoot);
  writeFileSync(tmpPath, JSON.stringify(index, null, 2), "utf8");
  try {
    renameSync(tmpPath, finalPath);
  } catch {
    // Fallback: direct write if rename fails (cross-device)
    writeFileSync(finalPath, JSON.stringify(index, null, 2), "utf8");
  }
}

export function loadIndex(projectRoot: string): WorkspaceIndex | null {
  const path = indexPath(projectRoot);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as WorkspaceIndex;
  } catch {
    // Corrupted → null → will rebuild
    return null;
  }
}

/**
 * Check if index is stale (> 5 minutes old).
 */
export function isIndexStale(projectRoot: string, maxAgeMs = 5 * 60_000): boolean {
  const path = indexPath(projectRoot);
  if (!existsSync(path)) return true;
  try {
    const stat = statSync(path);
    return Date.now() - stat.mtimeMs > maxAgeMs;
  } catch {
    return true;
  }
}
