import { describe, it, expect, afterEach } from "vitest";
import { getDb, closeAllDbs } from "../db.js";
import { setSecretScanEnabled } from "../secret-policy.js";
import type { Episode, VectorEntry } from "../types.js";

// Matches the AWS-access-key pattern in IngestionPipeline.SECRET_PATTERNS.
const SECRET = "AKIAIOSFODNN7EXAMPLE";

function episode(content: string): Episode {
  return {
    tenant_id: "default",
    session_id: "s1",
    memory_type: "episodic",
    state: "working" as any,
    goal: "g",
    turn_index: 0,
    action_signature: "a",
    content,
    metadata: {},
    created_at: Date.now(),
    is_archived: 0,
    confidence_score: 1,
    decay_factor: 1,
    lamport_timestamp: 1,
  };
}

function vector(content: string): VectorEntry {
  return {
    id: "v1",
    tenant_id: "default",
    memory_type: "semantic",
    state: "working" as any,
    vector: [0.1, 0.2, 0.3],
    content,
    metadata: {},
    lamport_timestamp: 1,
  };
}

describe("secret-on-persist", () => {
  afterEach(() => {
    setSecretScanEnabled(false);
    closeAllDbs();
  });

  it("stores content verbatim when scanning is off (legacy)", () => {
    setSecretScanEnabled(false);
    const backend = getDb(":memory:", ":memory:");
    backend.addEpisode(episode(`token ${SECRET} end`));
    expect(backend.queryEpisodes("s1")[0]!.content).toContain(SECRET);
  });

  it("redacts secrets in episode content when scanning is on", () => {
    setSecretScanEnabled(true);
    const backend = getDb(":memory:", ":memory:");
    backend.addEpisode(episode(`token ${SECRET} end`));
    const stored = backend.queryEpisodes("s1")[0]!.content;
    expect(stored).not.toContain(SECRET);
    expect(stored).toContain("[REDACTED-SECRET]");
    expect((backend as any).getSecretScanStats().redacted).toBe(1);
  });

  it("quarantines a secret-bearing vector instead of storing it live", () => {
    setSecretScanEnabled(true);
    const backend = getDb(":memory:", ":memory:");
    backend.insertVector(vector(`embedding of ${SECRET}`));

    expect(backend.queryVectors().length).toBe(0);
    const q = (backend as any).db.prepare("SELECT * FROM quarantined_vectors WHERE id = ?").get("v1");
    expect(q).toBeDefined();
    expect(q.error).toContain("secret");
    expect((backend as any).getSecretScanStats().quarantined).toBe(1);
  });

  it("stores a clean vector normally when scanning is on", () => {
    setSecretScanEnabled(true);
    const backend = getDb(":memory:", ":memory:");
    backend.insertVector(vector("just a normal sentence"));
    expect(backend.queryVectors().length).toBe(1);
  });
});
