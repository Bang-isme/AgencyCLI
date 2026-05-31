/**
 * Memory lifecycle manager — bounds memory growth so the runtime can operate
 * for weeks without the SQLite store growing without limit or filling with
 * duplicate / stale low-confidence noise.
 *
 * Closes the HIGH "unbounded table growth / no GC / no dedup / inert decay"
 * failure modes from docs/PRODUCTION_AUDIT.md (Memory subsystem). Reuses the
 * existing PolicyEngine/Graph integrity machinery; adds the row-quota, dedup,
 * and decay passes that were missing.
 *
 * One GC cycle = decay (age low-confidence) → dedup → quota-prune episodes →
 * quota-prune vectors → optional vacuum. Runs inside a single transaction so a
 * crash mid-cycle leaves the store consistent.
 */
import { getDb } from "./db.js";
import type { MemoryStorageBackend } from "./storage-backend.js";

export interface MemoryLifecycleOptions {
  /** Hard ceiling on episode rows. Oldest/lowest-confidence evicted past this. */
  maxEpisodes: number;
  /** Hard ceiling on vector rows. */
  maxVectors: number;
  /** Per-cycle confidence multiplier for aged, non-archived episodes (0–1). */
  decayRate: number;
  /** Episodes younger than this (ms) are exempt from decay. */
  decayGraceMs: number;
  /** Collapse duplicate episodes before quota enforcement. */
  dedupe: boolean;
  /** Reclaim freed pages with VACUUM when the cycle deleted rows. */
  vacuum: boolean;
}

export const DEFAULT_LIFECYCLE_OPTIONS: MemoryLifecycleOptions = {
  maxEpisodes: 50_000,
  maxVectors: 50_000,
  decayRate: 0.98,
  decayGraceMs: 7 * 24 * 60 * 60 * 1000, // 7 days
  dedupe: true,
  vacuum: false,
};

export interface GcReport {
  decayed: number;
  deduped: number;
  episodesPruned: number;
  vectorsPruned: number;
  episodesBefore: number;
  episodesAfter: number;
  vectorsBefore: number;
  vectorsAfter: number;
  durationMs: number;
}

export class MemoryLifecycleManager {
  private opts: MemoryLifecycleOptions;
  private timer: NodeJS.Timeout | null = null;

  constructor(opts: Partial<MemoryLifecycleOptions> = {}) {
    this.opts = { ...DEFAULT_LIFECYCLE_OPTIONS, ...opts };
  }

  /**
   * Runs a single maintenance cycle against `backend`. Transactional and
   * bounded. `now` is injectable for deterministic tests.
   */
  public runGcCycle(backend: MemoryStorageBackend, now: number = Date.now()): GcReport {
    const start = now;
    const episodesBefore = backend.countEpisodes();
    const vectorsBefore = backend.countVectors();

    const report = backend.runTransaction(() => {
      const decayed = backend.applyEpisodeDecay(this.opts.decayRate, this.opts.decayGraceMs, now);
      const deduped = this.opts.dedupe ? backend.dedupeEpisodes() : 0;
      const episodesPruned = backend.pruneEpisodesByQuota(this.opts.maxEpisodes);
      const vectorsPruned = backend.pruneVectorsByQuota(this.opts.maxVectors);
      return { decayed, deduped, episodesPruned, vectorsPruned };
    });

    if (this.opts.vacuum && report.deduped + report.episodesPruned + report.vectorsPruned > 0) {
      try {
        backend.vacuum();
      } catch {
        // VACUUM can fail under concurrent access; reclaiming space is best-effort.
      }
    }

    return {
      ...report,
      episodesBefore,
      episodesAfter: backend.countEpisodes(),
      vectorsBefore,
      vectorsAfter: backend.countVectors(),
      durationMs: Math.max(0, Date.now() - start),
    };
  }

  /**
   * Starts a background GC loop for long-running hosts (TUI, task runner).
   * The interval is unref'd so it never keeps the process alive on its own.
   * No-op for short-lived CLI commands — prefer a single {@link runGcCycle}.
   */
  public start(backend: MemoryStorageBackend, intervalMs: number, onCycle?: (r: GcReport) => void): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      try {
        const r = this.runGcCycle(backend);
        onCycle?.(r);
      } catch {
        // A failed cycle must never crash the host; the next tick retries.
      }
    }, intervalMs);
    this.timer.unref?.();
  }

  public stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}

/**
 * Convenience one-shot maintenance pass against a project's memory DB. Opens
 * (or reuses) the connection via getDb and runs a single GC cycle. Returns null
 * on any failure — maintenance must never block or crash the caller.
 */
export function runMemoryMaintenance(
  projectRoot: string,
  opts: Partial<MemoryLifecycleOptions> = {}
): GcReport | null {
  try {
    const backend = getDb(projectRoot);
    return new MemoryLifecycleManager(opts).runGcCycle(backend);
  } catch {
    return null;
  }
}
