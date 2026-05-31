import { describe, expect, it, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "../migrations.js";
import { SqliteStorageBackend } from "../storage-backend.js";
import { MemoryLifecycleManager } from "../lifecycle-manager.js";
import type { Episode } from "../types.js";

function freshBackend(): SqliteStorageBackend {
  const db = new Database(":memory:");
  runMigrations(db);
  return new SqliteStorageBackend(db);
}

let seq = 0;
function ep(over: Partial<Episode> = {}): Episode {
  seq += 1;
  return {
    tenant_id: "default",
    session_id: "s1",
    memory_type: "working",
    state: "ACTIVE",
    goal: "g",
    turn_index: seq,
    action_signature: `act-${seq}`,
    content: `content-${seq}`,
    metadata: {},
    created_at: 1000,
    is_archived: 0,
    confidence_score: 0.5,
    decay_factor: 1.0,
    lamport_timestamp: seq,
    ...over,
  };
}

describe("MemoryLifecycleManager", () => {
  beforeEach(() => {
    seq = 0;
  });

  it("prunes episodes down to the quota, evicting lowest-confidence first", () => {
    const b = freshBackend();
    // 5 episodes, distinct content; confidence varies
    b.addEpisode(ep({ content: "keep-hi", confidence_score: 0.9 }));
    b.addEpisode(ep({ content: "drop-lo1", confidence_score: 0.1 }));
    b.addEpisode(ep({ content: "drop-lo2", confidence_score: 0.2 }));
    b.addEpisode(ep({ content: "keep-mid", confidence_score: 0.7 }));
    b.addEpisode(ep({ content: "keep-hi2", confidence_score: 0.8 }));

    const mgr = new MemoryLifecycleManager({ maxEpisodes: 3, dedupe: false, decayGraceMs: 1 });
    const report = mgr.runGcCycle(b, 2000);

    expect(report.episodesBefore).toBe(5);
    expect(report.episodesAfter).toBe(3);
    expect(report.episodesPruned).toBe(2);

    const remaining = b.searchEpisodesFTS("keep OR drop").map((e) => e.content).sort();
    // The two lowest-confidence rows are gone; FTS stayed in sync via triggers.
    expect(remaining).not.toContain("drop-lo1");
    expect(remaining).not.toContain("drop-lo2");
  });

  it("dedupes episodes sharing (session, action, content), keeping the newest", () => {
    const b = freshBackend();
    b.addEpisode(ep({ action_signature: "dup", content: "same" }));
    b.addEpisode(ep({ action_signature: "dup", content: "same" }));
    b.addEpisode(ep({ action_signature: "dup", content: "same" }));
    b.addEpisode(ep({ action_signature: "unique", content: "other" }));

    const mgr = new MemoryLifecycleManager({ maxEpisodes: 100, dedupe: true, decayGraceMs: 1 });
    const report = mgr.runGcCycle(b, 2000);

    expect(report.deduped).toBe(2);
    expect(b.countEpisodes()).toBe(2);
  });

  it("decays confidence of aged non-archived episodes only", () => {
    const b = freshBackend();
    b.addEpisode(ep({ content: "old", created_at: 0, confidence_score: 1.0 }));
    b.addEpisode(ep({ content: "fresh", created_at: 9_000, confidence_score: 1.0 }));
    b.addEpisode(ep({ content: "archived-old", created_at: 0, confidence_score: 1.0, is_archived: 1 }));

    const mgr = new MemoryLifecycleManager({ maxEpisodes: 100, dedupe: false, decayRate: 0.5, decayGraceMs: 1000 });
    // now=10_000 → "old" age 10000 (>grace), "fresh" age 1000 (==grace, not >), archived exempt
    const report = mgr.runGcCycle(b, 10_000);
    expect(report.decayed).toBe(1);

    const rows = b.queryEpisodes("s1");
    const byContent = Object.fromEntries(rows.map((r) => [r.content, r.confidence_score]));
    expect(byContent["old"]).toBeCloseTo(0.5);
    expect(byContent["fresh"]).toBeCloseTo(1.0);
    expect(byContent["archived-old"]).toBeCloseTo(1.0);
  });

  it("prunes vectors down to the quota", () => {
    const b = freshBackend();
    for (let i = 0; i < 6; i++) {
      b.insertVector({
        id: `v${i}`,
        tenant_id: "default",
        memory_type: "knowledge",
        state: "ACTIVE",
        vector: [0.1, 0.2],
        content: `vec-${i}`,
        metadata: {},
        lamport_timestamp: i,
      });
    }
    const mgr = new MemoryLifecycleManager({ maxVectors: 2, maxEpisodes: 100, dedupe: false });
    const report = mgr.runGcCycle(b, 1);
    expect(report.vectorsPruned).toBe(4);
    expect(b.countVectors()).toBe(2);
    // Oldest (lowest lamport) evicted; newest retained.
    expect(b.queryVectors().map((v) => v.id).sort()).toEqual(["v4", "v5"]);
  });

  it("is a no-op when already under quota", () => {
    const b = freshBackend();
    b.addEpisode(ep());
    const mgr = new MemoryLifecycleManager({ maxEpisodes: 100, maxVectors: 100, dedupe: false, decayGraceMs: 1_000_000 });
    const report = mgr.runGcCycle(b, 2000);
    expect(report.episodesPruned).toBe(0);
    expect(report.vectorsPruned).toBe(0);
    expect(report.decayed).toBe(0);
    expect(b.countEpisodes()).toBe(1);
  });
});
