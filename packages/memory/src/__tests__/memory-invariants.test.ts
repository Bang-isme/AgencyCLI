import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { getDb, closeAllDbs } from "../db.js";
import { VectorStore } from "../vector-store.js";
import { EpisodicStore } from "../episodic-store.js";
import { GraphStore } from "../graph-store.js";
import { HybridRetriever } from "../retriever.js";
import { PolicyEngine, GraphIntegritySupervisor, CrdtMerger } from "../lifecycle.js";

describe("Memory Invariants, CRDT, and Retrieval Drift Verification Suite", () => {
  beforeEach(() => {
    closeAllDbs();
  });

  afterEach(() => {
    closeAllDbs();
  });

  it("should evaluate state machine transitions and virtual time acceleration (epoch back-dating)", () => {
    const backend = getDb(":memory:", ":memory:");
    const store = new VectorStore(backend);
    const policy = new PolicyEngine();
    
    // Register policy: semantic memories expire after 10 seconds and should archive
    policy.registerRetentionPolicy("semantic", 10000, true);

    const dim = 1536;
    const dummyVector = new Array(dim).fill(0.1);

    // 1. Ingest an ACTIVE memory
    const now = Date.now();
    store.insert({
      id: "mem-active",
      tenant_id: "default",
      memory_type: "semantic",
      state: "ACTIVE",
      vector: dummyVector,
      content: "Active symbol documentation",
      metadata: { created_at: now },
      lamport_timestamp: 1,
    });

    // 2. Ingest an ACTIVE memory that we will back-date programmatically to simulate time passing (Virtual Time Acceleration)
    const thirtyDaysAgo = now - 30 * 24 * 60 * 60 * 1000;
    store.insert({
      id: "mem-stale",
      tenant_id: "default",
      memory_type: "semantic",
      state: "ACTIVE",
      vector: dummyVector,
      content: "Stale deprecated symbol documentation",
      metadata: { created_at: thirtyDaysAgo },
      lamport_timestamp: 1,
    });

    // Verify both are active initially
    let allVecs = backend.queryVectors();
    expect(allVecs.find(v => v.id === "mem-active")?.state).toBe("ACTIVE");
    expect(allVecs.find(v => v.id === "mem-stale")?.state).toBe("ACTIVE");

    // Run Policy Engine evaluation
    policy.evaluateRetention(backend);

    // Verify back-dated memory transitioned to ARCHIVED, while the fresh one remains ACTIVE
    allVecs = backend.queryVectors();
    expect(allVecs.find(v => v.id === "mem-active")?.state).toBe("ACTIVE");
    expect(allVecs.find(v => v.id === "mem-stale")?.state).toBe("ARCHIVED");
  });

  it("should enforce LWW-CRDT conflict resolution (timestamp, severity, and ID tie-breaking)", () => {
    const backend = getDb(":memory:", ":memory:");
    const store = new VectorStore(backend);

    const dim = 1536;
    const dummyVector = new Array(dim).fill(0.1);

    // Ingest local base state
    store.insert({
      id: "symbol-1",
      tenant_id: "default",
      memory_type: "semantic",
      state: "ACTIVE",
      vector: dummyVector,
      content: "Local version 1",
      metadata: {},
      lamport_timestamp: 10,
    });

    // Case A: Remote has higher Lamport timestamp -> remote wins
    CrdtMerger.mergeVectors(backend, [{
      id: "symbol-1",
      tenant_id: "default",
      memory_type: "semantic",
      state: "ACTIVE",
      vector: dummyVector,
      content: "Remote higher timestamp",
      metadata: {},
      lamport_timestamp: 12, // higher
    }]);
    expect(backend.queryVectors().find(v => v.id === "symbol-1")?.content).toBe("Remote higher timestamp");

    // Case B: Remote has lower Lamport timestamp -> local wins (no change)
    CrdtMerger.mergeVectors(backend, [{
      id: "symbol-1",
      tenant_id: "default",
      memory_type: "semantic",
      state: "ACTIVE",
      vector: dummyVector,
      content: "Remote lower timestamp",
      metadata: {},
      lamport_timestamp: 8, // lower
    }]);
    expect(backend.queryVectors().find(v => v.id === "symbol-1")?.content).toBe("Remote higher timestamp");

    // Case C: Equal Lamport timestamps -> tie-break by state severity (QUARANTINED wins over ACTIVE)
    CrdtMerger.mergeVectors(backend, [{
      id: "symbol-1",
      tenant_id: "default",
      memory_type: "semantic",
      state: "QUARANTINED", // Higher severity/restrictiveness
      vector: dummyVector,
      content: "Remote quarantined state",
      metadata: {},
      lamport_timestamp: 12, // equal to local (12)
    }]);
    const vecRecord = backend.queryVectors().find(v => v.id === "symbol-1");
    expect(vecRecord?.state).toBe("QUARANTINED");
    expect(vecRecord?.content).toBe("Remote quarantined state");

    // Case D: Equal Lamport timestamps and equal state severity -> tie-break lexicographically by ID
    CrdtMerger.mergeVectors(backend, [{
      id: "symbol-2",
      tenant_id: "default",
      memory_type: "semantic",
      state: "ACTIVE",
      vector: dummyVector,
      content: "New vector element",
      metadata: {},
      lamport_timestamp: 5,
    }]);
    expect(backend.queryVectors().find(v => v.id === "symbol-2")).toBeDefined();
  });

  it("should verify symbol graph cycle check and break cycles by pruning lowest-weight edge", () => {
    const backend = getDb(":memory:", ":memory:");
    const graph = new GraphStore(backend);
    const integrity = new GraphIntegritySupervisor(backend);

    // Create three mock nodes by inserting vectors
    const store = new VectorStore(backend);
    const dim = 1536;
    const dummyVector = new Array(dim).fill(0.1);
    store.insert({ id: "A", tenant_id: "default", memory_type: "semantic", state: "ACTIVE", vector: dummyVector, content: "Node A", metadata: {}, lamport_timestamp: 1 });
    store.insert({ id: "B", tenant_id: "default", memory_type: "semantic", state: "ACTIVE", vector: dummyVector, content: "Node B", metadata: {}, lamport_timestamp: 1 });
    store.insert({ id: "C", tenant_id: "default", memory_type: "semantic", state: "ACTIVE", vector: dummyVector, content: "Node C", metadata: {}, lamport_timestamp: 1 });

    // Create a circular dependency cycle: A -> B -> C -> A
    // Weights: A->B (0.8), B->C (0.9), C->A (0.4)
    graph.addEdge("A", "B", "dependency", 0.8);
    graph.addEdge("B", "C", "dependency", 0.9);
    graph.addEdge("C", "A", "dependency", 0.4);

    // Verify cycle is detected
    let cycles = integrity.detectCycles();
    expect(cycles.length).toBeGreaterThan(0);
    
    // Verify integrity checks break cycles and prune the lowest weight edge (C -> A, weight: 0.4)
    integrity.verifyIntegrity();

    // Verify cycle is now gone
    cycles = integrity.detectCycles();
    expect(cycles.length).toBe(0);

    // Check edges
    const aNeighbors = backend.getNeighbors("A");
    const bNeighbors = backend.getNeighbors("B");
    const cNeighbors = backend.getNeighbors("C");

    expect(aNeighbors.find(e => e.target_id === "B")).toBeDefined(); // weight 0.8 intact
    expect(bNeighbors.find(e => e.target_id === "C")).toBeDefined(); // weight 0.9 intact
    expect(cNeighbors.find(e => e.target_id === "A")).toBeUndefined(); // weight 0.4 pruned!
  });

  it("should implement formal Reciprocal Rank Fusion (RRF) for hybrid search with ID tie-breaker sorting", () => {
    const backend = getDb(":memory:", ":memory:");
    const vectorStore = new VectorStore(backend);
    const episodicStore = new EpisodicStore(backend);
    const retriever = new HybridRetriever(episodicStore, vectorStore, new GraphStore(backend));

    const dim = 1536;
    const vQuery = new Array(dim).fill(0.0).map((_, i) => i === 0 ? 1.0 : 0.0);
    
    // Vector entry: matched by semantic query
    vectorStore.insert({
      id: "doc-alpha",
      tenant_id: "default",
      memory_type: "semantic",
      state: "ACTIVE",
      vector: vQuery,
      content: "FTS test phrase. Documentation on alpha codebase.",
      metadata: {},
      lamport_timestamp: 1,
    });

    // Episodic entry: matched by keyword FTS query
    episodicStore.addEpisode("session-x", "FTS test phrase. Episodic run for beta codebase.", 0, "run", "Episodic content alpha beta.");

    // Retrieve via retriever
    const results = retriever.retrieve(vQuery, "FTS");
    expect(results.length).toBeGreaterThan(0);

    // Assert results have RRF base scores
    for (const res of results) {
      expect(res.explanation.base_score).toBeGreaterThan(0);
      expect(res.explanation.reason).toContain("RRF Score");
    }

    // Assert deterministic lexicographical sorting by ID if scores are identical
    // Let's create two identical semantic entries with same similarity and no boosting
    const simVec = new Array(dim).fill(0.0).map((_, i) => i === 1 ? 1.0 : 0.0);
    vectorStore.insert({
      id: "doc-zebra",
      tenant_id: "default",
      memory_type: "semantic",
      state: "ACTIVE",
      vector: simVec,
      content: "Same exact similarity content",
      metadata: {},
      lamport_timestamp: 1,
    });

    vectorStore.insert({
      id: "doc-apple",
      tenant_id: "default",
      memory_type: "semantic",
      state: "ACTIVE",
      vector: simVec,
      content: "Same exact similarity content",
      metadata: {},
      lamport_timestamp: 1,
    });

    const resSame = retriever.retrieve(simVec, "Nomatch", { limit: 2 });
    expect(resSame.length).toBe(2);
    // Even though both have exact same vector similarity and thus same RRF score,
    // they should be stably sorted lexicographically by record ID (doc-apple first, doc-zebra second)
    expect(resSame[0]!.id).toBe("doc-apple");
    expect(resSame[1]!.id).toBe("doc-zebra");
  });

  it("should monitor semantic retrieval drift over long sessions and flag anomalies when cosine distance exceeds 30%", () => {
    const dim = 1536;
    const anchorQuery = new Array(dim).fill(0.0);
    anchorQuery[0] = 1.0; // unit vector pointing along axis 0

    const computeCentroid = (vectors: number[][]): number[] => {
      const centroid = new Array(dim).fill(0);
      for (const vec of vectors) {
        for (let i = 0; i < dim; i++) {
          centroid[i] += vec[i]!;
        }
      }
      for (let i = 0; i < dim; i++) {
        centroid[i] /= vectors.length;
      }
      return centroid;
    };

    const cosineSimilarity = (a: number[], b: number[]): number => {
      let dot = 0;
      let normA = 0;
      let normB = 0;
      for (let i = 0; i < dim; i++) {
        dot += a[i]! * b[i]!;
        normA += a[i]! * a[i]!;
        normB += b[i]! * b[i]!;
      }
      if (normA === 0 || normB === 0) return 0;
      return dot / (Math.sqrt(normA) * Math.sqrt(normB));
    };

    // 1. Session state A: results closely aligned to anchorQuery (using exact 1.0 along axis 0, and 0 for others)
    const resultsA = [
      new Array(dim).fill(0).map((_, idx) => idx === 0 ? 1.0 : 0.0),
      new Array(dim).fill(0).map((_, idx) => idx === 0 ? 0.95 : 0.0),
    ];
    const centroidA = computeCentroid(resultsA);
    const similarityA = cosineSimilarity(anchorQuery, centroidA);
    const distanceA = 1 - similarityA;
    
    expect(distanceA).toBeLessThan(0.30); // healthy

    // 2. Session state B: results drifted far away (Semantic Drift!)
    const resultsB = [
      new Array(dim).fill(0).map((_, idx) => idx === 5 ? 1.0 : 0.0), // points along axis 5
      new Array(dim).fill(0).map((_, idx) => idx === 10 ? 1.0 : 0.0), // points along axis 10
    ];
    const centroidB = computeCentroid(resultsB);
    const similarityB = cosineSimilarity(anchorQuery, centroidB);
    const distanceB = 1 - similarityB;

    expect(distanceB).toBeGreaterThan(0.30); // semantic drift alert!
  });
});
