import { describe, it, expect } from "vitest";
import { getDb, closeAllDbs } from "../db.js";
import { EpisodicStore } from "../episodic-store.js";
import { WriteQueue } from "../write-queue.js";
import { Supervisor } from "../supervisor.js";

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
});
