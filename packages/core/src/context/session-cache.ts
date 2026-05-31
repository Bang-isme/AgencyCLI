import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RouteResult } from "../router/model-router.js";

const TTL_MS = 60 * 60 * 1000;

interface RouteCacheEntry {
  prompt: string;
  route: RouteResult;
  cachedAt: string;
}

interface RouteCacheFile {
  version: 1;
  entries: Record<string, RouteCacheEntry>;
}

function cachePath(projectRoot: string): string {
  return join(projectRoot, ".agency", "session", "route-cache.json");
}

function promptKey(prompt: string): string {
  return createHash("sha256").update(prompt.trim()).digest("hex");
}

function emptyCache(): RouteCacheFile {
  return { version: 1, entries: {} };
}

function loadCache(projectRoot: string): RouteCacheFile {
  const path = cachePath(projectRoot);
  if (!existsSync(path)) return emptyCache();
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as RouteCacheFile;
    return { version: 1, entries: raw.entries ?? {} };
  } catch {
    return emptyCache();
  }
}

function saveCache(projectRoot: string, cache: RouteCacheFile): void {
  const dir = join(projectRoot, ".agency", "session");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    cachePath(projectRoot),
    `${JSON.stringify(cache, null, 2)}\n`,
    "utf8"
  );
}

function isExpired(cachedAt: string, now = Date.now()): boolean {
  const ts = Date.parse(cachedAt);
  if (Number.isNaN(ts)) return true;
  return now - ts >= TTL_MS;
}

function pruneExpired(cache: RouteCacheFile, now = Date.now()): RouteCacheFile {
  const entries: Record<string, RouteCacheEntry> = {};
  for (const [key, entry] of Object.entries(cache.entries)) {
    if (!isExpired(entry.cachedAt, now)) {
      entries[key] = entry;
    }
  }
  return { version: 1, entries };
}

export function getCachedRoute(
  projectRoot: string,
  prompt: string
): RouteResult | null {
  const cache = pruneExpired(loadCache(projectRoot));
  const entry = cache.entries[promptKey(prompt)];
  if (!entry || isExpired(entry.cachedAt)) return null;
  return entry.route;
}

/** Clear route cache for tests or `/new` session flows. */
export function clearRouteCache(projectRoot: string): void {
  const path = cachePath(projectRoot);
  try {
    if (existsSync(path)) unlinkSync(path);
  } catch (err: any) {
    if (err.code === "EPERM" || err.code === "EACCES") {
      try {
        writeFileSync(path, `${JSON.stringify(emptyCache(), null, 2)}\n`, "utf8");
      } catch {}
    } else if (err.code !== "ENOENT") {
      throw err;
    }
  }
}

export function setCachedRoute(
  projectRoot: string,
  prompt: string,
  route: RouteResult
): void {
  const cache = pruneExpired(loadCache(projectRoot));
  cache.entries[promptKey(prompt)] = {
    prompt: prompt.trim(),
    route,
    cachedAt: new Date().toISOString(),
  };
  saveCache(projectRoot, cache);
}
