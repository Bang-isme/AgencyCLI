import { describe, it, expect } from "vitest";
import { getDb, closeAllDbs } from "../db.js";
import { EpisodicStore } from "../episodic-store.js";
import { WriteQueue } from "../write-queue.js";
import { Supervisor } from "../supervisor.js";
import { RevisionMismatch } from "../types.js";

describe("Database Concurrency & Queue Stress Tests", () => {
  it("should serialize writes and prevent lock conflicts during concurrent transactions", async () => {
    const backend = getDb(":memory:", ":memory:");
    const store = new EpisodicStore(backend);
    const queue = new WriteQueue();
    const supervisor = new Supervisor(backend);

    const concurrentWrites: Promise<void>[] = [];
    const count = 15;

    for (let i = 0; i < count; i++) {
      const task = () => {
        return queue.enqueue(() => {
          return supervisor.safeWrite(() => {
            store.addEpisode(
              "concurrent-session",
              `Goal ${i}`,
              i,
              "run",
              `Content ${i}`
            );
          });
        });
      };
      concurrentWrites.push(task());
    }

    // Await all competing writes
    await Promise.all(concurrentWrites);

    const episodes = store.getEpisodes("concurrent-session");
    expect(episodes.length).toBe(count);
    
    // Verify sequence is preserved by serial queue
    for (let i = 0; i < count; i++) {
      expect(episodes[i]!.turn_index).toBe(i);
    }

    closeAllDbs();
  });

  it("should throw RevisionMismatch on incorrect expected revision and retry via safeWriteAsync", async () => {
    const backend = getDb(":memory:", ":memory:");
    const store = new EpisodicStore(backend);
    const supervisor = new Supervisor(backend);

    // Initial episode
    store.addEpisode("session-occ", "Initial Goal", 0, "run", "Initial Content");

    // The current revision in DB should be 1.
    // Try to insert with expectedRevision = 0 (mismatch).
    expect(() => {
      store.addEpisode(
        "session-occ",
        "Goal 2",
        1,
        "run",
        "Content 2",
        {},
        "default",
        "episodic",
        0 // expectedRevision
      );
    }).toThrow(RevisionMismatch);

    // Try to insert with expectedRevision = 1 (match).
    // This should succeed.
    store.addEpisode(
      "session-occ",
      "Goal 2",
      1,
      "run",
      "Content 2",
      {},
      "default",
      "episodic",
      1 // expectedRevision
    );

    // Now test retries with safeWriteAsync.
    let attemptCount = 0;
    const staleRevision = 2;

    await supervisor.safeWriteAsync(() => {
      attemptCount++;
      if (attemptCount === 1) {
        // First attempt: try to insert with stale revision 1, but actual is 2.
        // This will throw RevisionMismatch.
        store.addEpisode(
          "session-occ",
          "Goal A",
          2,
          "run",
          `Content A (attempt ${attemptCount})`,
          {},
          "default",
          "episodic",
          staleRevision - 1
        );
      } else {
        // Second attempt: read correct max revision (2) and succeed.
        const currentMaxRev = store.getEpisodes("session-occ").length;
        store.addEpisode(
          "session-occ",
          "Goal A",
          2,
          "run",
          `Content A (attempt ${attemptCount})`,
          {},
          "default",
          "episodic",
          currentMaxRev
        );
      }
    }, 5, 20);

    expect(attemptCount).toBe(2);

    closeAllDbs();
  });
});
