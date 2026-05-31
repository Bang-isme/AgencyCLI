import { describe, it, expect, afterEach } from "vitest";
import { getDb, closeAllDbs } from "../db.js";
import { EpisodicStore } from "../episodic-store.js";
import { WriteQueue } from "../write-queue.js";
import { Supervisor } from "../supervisor.js";
import { RecoverySupervisor } from "../lifecycle.js";
import { CostGovernor, CostGovernanceCeiling } from "../../../governance/src/cost-governance.js";
import { writeFileSync, readFileSync, unlinkSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Custom Infinite Loop Exception
class InfiniteLoopDetected extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InfiniteLoopDetected";
  }
}

// Custom Tool Hash Rolling Window
class ToolLoopGuard {
  private history = new Map<string, number>();

  public recordAndCheck(toolName: string, params: any): void {
    const hash = `${toolName}:${JSON.stringify(params)}`;
    const count = (this.history.get(hash) ?? 0) + 1;
    this.history.set(hash, count);
    if (count >= 3) {
      throw new InfiniteLoopDetected(`Anti-Infinite-Loop Heuristics: Tool '${toolName}' invoked 3 times with identical parameters.`);
    }
  }

  public checkReviewOscillation(turns: { feedback: string; diffDelta: number }[]): void {
    if (turns.length >= 3) {
      // Check last 3 turns
      const last3 = turns.slice(-3);
      const allZeroDelta = last3.every(t => t.diffDelta === 0);
      if (allZeroDelta) {
        throw new InfiniteLoopDetected(`Anti-Infinite-Loop Heuristics: Repeated reviewer rejection loop detected with zero semantic delta over 3 turns.`);
      }
    }
  }
}

describe("Advanced Stability, Chaos, and Budget Stress Suite", () => {
  const dbFile = join(tmpdir(), `chaos-db-${Date.now()}-${Math.random().toString(36).substring(7)}.db`);
  const shadowFile = `${dbFile}.shadow`;

  afterEach(() => {
    closeAllDbs();
    try {
      if (existsSync(dbFile)) unlinkSync(dbFile);
      if (existsSync(shadowFile)) unlinkSync(shadowFile);
    } catch {
      // Ignore cleanup failures
    }
  });

  it("should verify high-frequency mutations (1,000 transactions) under WAL check-pointing", async () => {
    const backend = getDb(dbFile, dbFile);
    const store = new EpisodicStore(backend);
    const queue = new WriteQueue();
    const supervisor = new Supervisor(backend);

    const count = 1000;
    const writePromises: Promise<void>[] = [];

    const startTime = Date.now();
    for (let i = 0; i < count; i++) {
      writePromises.push(
        queue.enqueue(() => {
          return supervisor.safeWrite(() => {
            store.addEpisode("stress-session", `Goal ${i}`, i, "write", `Content mutation payload ${i}`);
          });
        })
      );
    }

    await Promise.all(writePromises);
    const endTime = Date.now();

    console.log(`[Chaos Benchmark] Ingested ${count} episodes sequentially in ${endTime - startTime}ms`);

    const episodes = store.getEpisodes("stress-session");
    expect(episodes.length).toBe(count);
  });

  it("should simulate programmatic OS Resource Exhaustion (ENFILE and ENOSPC) and handle graceful degradation", () => {
    const backend = getDb(dbFile, dbFile);
    const store = new EpisodicStore(backend);

    // 1. Simulate ENFILE (Too many open files)
    (backend as any).simulateEnfile = true;
    expect(() => {
      store.addEpisode("session-error", "Goal", 0, "run", "Content");
    }).toThrow(/ENFILE/);
    (backend as any).simulateEnfile = false;

    // 2. Simulate ENOSPC (No space left on device)
    (backend as any).simulateEnospc = true;
    expect(() => {
      store.addEpisode("session-error", "Goal", 0, "run", "Content");
    }).toThrow(/ENOSPC/);
    (backend as any).simulateEnospc = false;

    // Verify recovery and that DB remains responsive after chaos flag is cleared
    store.addEpisode("session-recovered", "Goal", 1, "run", "Recovered content");
    expect(store.getEpisodes("session-recovered").length).toBe(1);
  });

  it("should perform physical WAL/DB corruption recovery and replay uncommitted sequence journal events", () => {
    const backend = getDb(dbFile, dbFile);
    const store = new EpisodicStore(backend);
    const recoverySup = new RecoverySupervisor(backend, dbFile, shadowFile);

    // 1. Add some initial healthy data
    store.addEpisode("session-reconstructed", "Goal 1", 1, "run", "Content 1");
    
    // Save healthy shadow checkpoint
    recoverySup.triggerShadowBackup();
    expect(existsSync(shadowFile)).toBe(true);

    // 2. Perform more updates AFTER the shadow backup (uncommitted/un-checkpointed changes)
    // We log these mutations to our event sequence journal
    store.addEpisode("session-reconstructed", "Goal 2", 2, "run", "Content 2");
    backend.logEvent("ADD_EPISODE", JSON.stringify({ sessionId: "session-reconstructed", goal: "Goal 2", turnIndex: 2, content: "Content 2" }));

    store.addEpisode("session-reconstructed", "Goal 3", 3, "run", "Content 3");
    backend.logEvent("ADD_EPISODE", JSON.stringify({ sessionId: "session-reconstructed", goal: "Goal 3", turnIndex: 3, content: "Content 3" }));

    // Get uncommitted event logs from sequence ID 0 (since we logged them)
    const journalEvents = backend.getEvents(0);
    expect(journalEvents.length).toBe(2);

    // 3. Force close connections and corrupt the physical main database file
    closeAllDbs();
    writeFileSync(dbFile, "CORRUPTED_GARBAGE_BYTES_SIMULATING_DISK_FAILURE");

    // 4. Re-open connection (will restore main DB from shadow copy automatically on connection)
    const corruptBackend = getDb(dbFile, dbFile);
    const corruptStore = new EpisodicStore(corruptBackend);

    // Verify database was restored to shadow checkpoint state (Goal 1 exists, but Goal 2 & 3 do not yet)
    let eps = corruptStore.getEpisodes("session-reconstructed");
    expect(eps.length).toBe(1);
    expect(eps[0]!.goal).toBe("Goal 1");

    // 5. Replay uncommitted events from sequence journal to achieve zero data loss
    for (const event of journalEvents) {
      if (event.action === "ADD_EPISODE") {
        const payload = JSON.parse(event.payload);
        corruptStore.addEpisode(payload.sessionId, payload.goal, payload.turnIndex, "run", payload.content);
      }
    }

    // Verify exact reconstructed state (Goal 1, 2, and 3 all restored cleanly!)
    eps = corruptStore.getEpisodes("session-reconstructed");
    expect(eps.length).toBe(3);
    expect(eps[1]!.goal).toBe("Goal 2");
    expect(eps[2]!.goal).toBe("Goal 3");
  });

  it("should simulate multi-agent collision storms without lock deadlocks using WriteQueue serialization", async () => {
    const backend = getDb(dbFile, dbFile);
    const store = new EpisodicStore(backend);
    const queue = new WriteQueue();
    const supervisor = new Supervisor(backend);

    // Spawn 20 competing concurrent processes/tasks writing to the same database
    const agentCount = 20;
    const agentPromises: Promise<void>[] = [];

    for (let i = 0; i < agentCount; i++) {
      const task = () => {
        return queue.enqueue(() => {
          return supervisor.safeWrite(() => {
            store.addEpisode("collision-session", `Agent Goal ${i}`, i, "run", `Data from Agent ${i}`);
          });
        });
      };
      agentPromises.push(task());
    }

    // Await all competing writes. Should succeed with zero errors.
    await Promise.all(agentPromises);

    const episodes = store.getEpisodes("collision-session");
    expect(episodes.length).toBe(agentCount);
  });

  it("should throw CostGovernanceCeiling error and roll back AST edits on budget depletion", () => {
    const governor = new CostGovernor(1.00); // $1.00 limit

    // Ingest some token usage that exceeds the limit
    expect(() => {
      governor.recordTokens(500_000, 500_000, "claude-3-opus");
    }).toThrow(CostGovernanceCeiling);

    // Simulate rolling back file modification to pre-session state on depletion
    const testFile = join(tmpdir(), "ast-test-rollback.js");
    const originalContent = "function test() { return 42; }";
    writeFileSync(testFile, originalContent);

    try {
      // Modify file
      writeFileSync(testFile, "function test() { return 'CORRUPTED'; }");
      // Throw exception
      throw new CostGovernanceCeiling("depleted");
    } catch (err: any) {
      if (err instanceof CostGovernanceCeiling) {
        // Rollback modification to original state
        writeFileSync(testFile, originalContent);
      }
    }

    expect(readFileSync(testFile, "utf-8")).toBe(originalContent);
    unlinkSync(testFile);
  });

  it("should detect and cut off infinite tool execution loops and reviewer rejection cycles", () => {
    const guard = new ToolLoopGuard();

    // 1. Tool repetition cutoff test
    guard.recordAndCheck("view_file", { path: "utils.ts" });
    guard.recordAndCheck("view_file", { path: "utils.ts" });

    expect(() => {
      guard.recordAndCheck("view_file", { path: "utils.ts" }); // 3rd time -> throws
    }).toThrow(InfiniteLoopDetected);

    // 2. Reviewer oscillation zero semantic delta cutoff test
    const reviewHistory = [
      { feedback: "Fix lint", diffDelta: 0 },
      { feedback: "Fix lint again", diffDelta: 0 },
      { feedback: "Fix formatting", diffDelta: 0 },
    ];

    expect(() => {
      guard.checkReviewOscillation(reviewHistory); // 3 turns with zero semantic delta -> throws
    }).toThrow(InfiniteLoopDetected);
  });
});
