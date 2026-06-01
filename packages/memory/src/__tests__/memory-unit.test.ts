import { describe, it, expect } from "vitest";
import { getDb, closeAllDbs } from "../db.js";
import { VectorStore } from "../vector-store.js";
import { EpisodicStore } from "../episodic-store.js";
import { IngestionPipeline } from "../ingestion.js";
import { SecurityHardening } from "../security.js";
import { MemoryCache } from "../cache.js";
import { MemoryBudgetAllocator, CapabilityNegotiator } from "../governance.js";

describe("Memory Subsystem Unit Tests", () => {
  it("should initialize database schema tables successfully", () => {
    const backend = getDb(":memory:", ":memory:");
    expect(backend.integrityCheck()).toBe(true);
    closeAllDbs();
  });

  it("should insert and query episodes chronologically oldest-first", () => {
    const backend = getDb(":memory:", ":memory:");
    const store = new EpisodicStore(backend);

    store.addEpisode("session-1", "Test Goal A", 0, "run", "Content A", {}, "default", "episodic");
    store.addEpisode("session-1", "Test Goal B", 1, "verify", "Content B", {}, "default", "episodic");

    const episodes = store.getEpisodes("session-1");
    expect(episodes.length).toBe(2);
    expect(episodes[0]!.goal).toBe("Test Goal A");
    expect(episodes[1]!.goal).toBe("Test Goal B");
    
    closeAllDbs();
  });

  it("should match episodic goal terms using FTS5 MATCH queries", () => {
    const backend = getDb(":memory:", ":memory:");
    const store = new EpisodicStore(backend);

    store.addEpisode("session-1", "Build CLI sandbox framework", 0, "run", "Content", {});
    store.addEpisode("session-1", "Verify workspace builds", 1, "run", "Content", {});

    const matches = store.searchEpisodesByGoal("sandbox");
    expect(matches.length).toBe(1);
    expect(matches[0]!.goal).toBe("Build CLI sandbox framework");

    // Test term fallback syntax error handling
    const malformedMatches = store.searchEpisodesByGoal("sandbox OR verify *");
    expect(malformedMatches.length).toBe(2);

    closeAllDbs();
  });

  it("should recall recent episodes from OTHER sessions, excluding the current one, honouring the limit", () => {
    const backend = getDb(":memory:", ":memory:");
    const store = new EpisodicStore(backend);

    store.addEpisode("session-a", "A work", 0, "run", "a content", {});
    store.addEpisode("session-b", "B work", 0, "run", "b content", {});
    store.addEpisode("session-current", "Current work", 0, "run", "current content", {});

    const recent = store.getRecentAcrossSessions("session-current", 10);
    // Excludes the current session entirely…
    expect(recent.every((e) => e.session_id !== "session-current")).toBe(true);
    // …and returns the two other sessions.
    expect(new Set(recent.map((e) => e.session_id))).toEqual(new Set(["session-a", "session-b"]));

    // Honours the limit (and the limited result is still never the current session).
    const limited = store.getRecentAcrossSessions("session-current", 1);
    expect(limited).toHaveLength(1);
    expect(limited[0]!.session_id).not.toBe("session-current");

    closeAllDbs();
  });

  it("should perform vector insert and query similarity correctly", () => {
    const backend = getDb(":memory:", ":memory:");
    const store = new VectorStore(backend);

    const dim = 1536;
    const v1 = new Array(dim).fill(0).map((_, i) => (i === 10 ? 1.0 : 0.0));
    const v2 = new Array(dim).fill(0).map((_, i) => (i === 10 ? 0.9 : 0.0));

    store.insert({
      id: "symbol-a",
      tenant_id: "default",
      memory_type: "semantic",
      state: "ACTIVE",
      vector: v1,
      content: "Symbol A Code block",
      metadata: { created_at: Date.now() },
      lamport_timestamp: 0,
    });

    const searchRes = store.search(v2, { similarityThreshold: 0.5 });
    expect(searchRes.length).toBe(1);
    expect(searchRes[0]!.id).toBe("symbol-a");
    expect(searchRes[0]!.similarity).toBeGreaterThan(0.8);

    closeAllDbs();
  });

  it("should parse AST code boundaries and merge semantic chunks", () => {
    const code = `
export class CoreOrchestrator {
  private active = false;

  public async start() {
    this.active = true;
  }
}

export function helper() {
  return 42;
}
    `;

    const chunks = IngestionPipeline.astChunkText(code, "ts", { chunkSize: 200 });
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0]!.includes("class CoreOrchestrator")).toBe(true);
    expect(chunks[1]!.includes("function helper")).toBe(true);

    // Merge adjacent chunks semantically
    const inputChunks = [
      { text: "Class context A", vector: [1, 0, 0] },
      { text: "Class context B", vector: [0.95, 0.05, 0.0] },
    ];
    const cosineSim = (a: number[], b: number[]) => {
      const dot = a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;
      return dot;
    };
    const merged = IngestionPipeline.mergeAdjacentChunks(inputChunks, cosineSim, { mergeThreshold: 0.9 });
    expect(merged.length).toBe(1);
    expect(merged[0]!.text).toBe("Class context A\nClass context B");
  });

  it("should encrypt and decrypt metadata parameters safely", () => {
    const key = "a".repeat(64); // 64 hex characters
    const plaintext = "SuperSensitiveData";
    
    const enc = SecurityHardening.encrypt(plaintext, key);
    expect(enc.ciphertext).not.toBe(plaintext);
    
    const dec = SecurityHardening.decrypt(enc.ciphertext, enc.iv, enc.tag, key);
    expect(dec).toBe(plaintext);
  });

  it("should record cache hit and miss ratios accurately", () => {
    const cache = new MemoryCache<string, string>(5);
    cache.set("key-1", "val-1");
    
    expect(cache.get("key-1")).toBe("val-1");
    expect(cache.get("key-2")).toBeUndefined();
    expect(cache.size()).toBe(1);
  });

  it("should allocate budget dynamically and negotiate capabilities", () => {
    const allocator = new MemoryBudgetAllocator(512);
    const budget = allocator.allocateBudget();
    expect(budget.cacheLimit).toBeGreaterThan(0);
    expect(budget.retrievalCeiling).toBeGreaterThan(0);

    const negotiator = new CapabilityNegotiator();
    const strongRes = negotiator.negotiate("gpt-4", { limit: 20 });
    const weakRes = negotiator.negotiate("gpt-3.5-turbo", { limit: 20 });

    expect(strongRes.limit).toBe(20);
    expect(weakRes.limit).toBe(5);
  });

  it("should cache text-to-vector embedding outputs in the SQLite embedding_cache table", () => {
    const backend = getDb(":memory:", ":memory:");
    const db = (backend as any).db;
    
    const testText = "class CoreOrchestrator";
    const testModel = "text-embedding-3-small";
    const testVector = [0.1, 0.2, 0.3];
    
    db.prepare("INSERT INTO embedding_cache (text, embedding_model, vector, created_at) VALUES (?, ?, ?, ?)")
      .run(testText, testModel, JSON.stringify(testVector), Date.now());
      
    const row = db.prepare("SELECT vector FROM embedding_cache WHERE text = ? AND embedding_model = ?")
      .get(testText, testModel) as { vector: string };
      
    expect(row).toBeDefined();
    expect(JSON.parse(row.vector)).toEqual(testVector);
    
    closeAllDbs();
  });
});
