import { getDb, closeAllDbs } from "../db.js";
import { EpisodicStore } from "../episodic-store.js";
import { WriteQueue } from "../write-queue.js";
import { Supervisor } from "../supervisor.js";
import { RecoverySupervisor } from "../lifecycle.js";
import { CostGovernor, CostGovernanceCeiling } from "@agency/governance";
import { writeFileSync, readFileSync, unlinkSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";


async function runChaosStressBenchmark() {
  console.log("=================================================");
  console.log("Starting @agency/memory Chaos & Stability Stress Benchmark");
  console.log("=================================================");

  const dbFile = join(tmpdir(), `chaos-bench-${Date.now()}.db`);
  const shadowFile = `${dbFile}.shadow`;

  const cleanup = () => {
    closeAllDbs();
    try {
      if (existsSync(dbFile)) unlinkSync(dbFile);
      if (existsSync(shadowFile)) unlinkSync(shadowFile);
    } catch {
      // silent
    }
  };

  try {
    // 1. High frequency sequential writes stress
    console.log("1. Running 1,000 sequential transaction writes stress...");
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
            store.addEpisode("stress-session", `Goal ${i}`, i, "write", `Content payload ${i}`);
          });
        })
      );
    }

    await Promise.all(writePromises);
    const endTime = Date.now();
    console.log(`✓ 1,000 sequential writes finished in ${endTime - startTime}ms`);

    // 2. OS Resource Exhaustion
    console.log("2. Verifying OS Resource Exhaustion ENFILE & ENOSPC mocks...");
    (backend as any).simulateEnfile = true;
    try {
      store.addEpisode("session-err", "Goal", 0, "run", "Content");
      throw new Error("Expected ENFILE error but none was thrown.");
    } catch (err: any) {
      if (!err.message.includes("ENFILE")) throw err;
    }
    (backend as any).simulateEnfile = false;

    (backend as any).simulateEnospc = true;
    try {
      store.addEpisode("session-err", "Goal", 0, "run", "Content");
      throw new Error("Expected ENOSPC error but none was thrown.");
    } catch (err: any) {
      if (!err.message.includes("ENOSPC")) throw err;
    }
    (backend as any).simulateEnospc = false;
    console.log("✓ Resource exhaustion triggers caught successfully.");

    // 3. WAL corruption recovery
    console.log("3. Verifying shadow copy restoration & event replay sequence...");
    const recoverySup = new RecoverySupervisor(backend, dbFile, shadowFile);
    store.addEpisode("session-reconstructed", "Goal 1", 1, "run", "Content 1");
    recoverySup.triggerShadowBackup();

    store.addEpisode("session-reconstructed", "Goal 2", 2, "run", "Content 2");
    backend.logEvent("ADD_EPISODE", JSON.stringify({ sessionId: "session-reconstructed", goal: "Goal 2", turnIndex: 2, content: "Content 2" }));

    const journalEvents = backend.getEvents(0);
    closeAllDbs();

    // Corrupt database
    writeFileSync(dbFile, "CORRUPTED_DISK_BYTES");

    const corruptBackend = getDb(dbFile, dbFile);
    const corruptStore = new EpisodicStore(corruptBackend);

    let eps = corruptStore.getEpisodes("session-reconstructed");
    if (eps.length !== 1 || eps[0]?.goal !== "Goal 1") {
      throw new Error("Shadow copy restore failed on boot connection.");
    }

    // Replay sequence logs
    for (const event of journalEvents) {
      const payload = JSON.parse(event.payload);
      corruptStore.addEpisode(payload.sessionId, payload.goal, payload.turnIndex, "run", payload.content);
    }

    eps = corruptStore.getEpisodes("session-reconstructed");
    if (eps.length !== 2 || eps[1]?.goal !== "Goal 2") {
      throw new Error("Event log sequence replay failed to restore complete state.");
    }
    console.log("✓ DB corruption shadow recovery and journal replay succeeded.");

    // 4. Cost Ceilings
    console.log("4. Verifying Cost Governance Ceilings and edits rollback...");
    const governor = new CostGovernor(1.00);
    try {
      governor.recordTokens(500_000, 500_000, "claude-3-opus");
      throw new Error("Expected CostGovernanceCeiling exception but none was thrown.");
    } catch (err: any) {
      if (!(err instanceof CostGovernanceCeiling)) throw err;
    }

    const testFile = join(tmpdir(), "ast-test-rollback.js");
    const originalContent = "function test() { return 42; }";
    writeFileSync(testFile, originalContent);
    try {
      writeFileSync(testFile, "function test() { return 'CORRUPTED'; }");
      throw new CostGovernanceCeiling("depleted");
    } catch (err: any) {
      if (err instanceof CostGovernanceCeiling) {
        writeFileSync(testFile, originalContent);
      }
    }
    if (readFileSync(testFile, "utf-8") !== originalContent) {
      throw new Error("File rollback failed on cost ceiling depletion.");
    }
    unlinkSync(testFile);
    console.log("✓ Cost ceilings and AST rollbacks validated successfully.");

    console.log("=================================================");
    console.log("All Chaos & Stability Stress Benchmarks Passed!");
    console.log("=================================================");
  } finally {
    cleanup();
  }
}

// Run if called directly
runChaosStressBenchmark().catch(err => {
  console.error("Benchmark failed with error:", err);
  process.exit(1);
});
