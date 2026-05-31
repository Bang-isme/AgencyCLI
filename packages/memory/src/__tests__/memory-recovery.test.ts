import { describe, it, expect, afterEach } from "vitest";
import { writeFileSync, unlinkSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getDb, closeAllDbs } from "../db.js";
import { EpisodicStore } from "../episodic-store.js";
import { RecoverySupervisor } from "../lifecycle.js";
import { Supervisor } from "../supervisor.js";

describe("Database Integrity and Recovery Drills", () => {
  const dbFile = join(tmpdir(), `test-recovery-${Date.now()}-${Math.random().toString(36).substring(7)}.db`);
  const shadowFile = `${dbFile}.shadow`;

  afterEach(() => {
    closeAllDbs();
    try {
      if (existsSync(dbFile)) unlinkSync(dbFile);
      if (existsSync(shadowFile)) unlinkSync(shadowFile);
    } catch {
      // Ignore files that are already deleted
    }
  });

  it("should trigger shadow backup and recover corrupted databases cleanly", () => {
    const backend = getDb(dbFile, dbFile);
    const store = new EpisodicStore(backend);
    const supervisor = new RecoverySupervisor(backend, dbFile, shadowFile);

    store.addEpisode("session-a", "Goal", 0, "run", "Sample Content");
    
    // Create healthy shadow backup
    supervisor.triggerShadowBackup();
    expect(existsSync(shadowFile)).toBe(true);

    // Force close active connections before corrupting file
    closeAllDbs();

    // Simulate corruption by overwriting database with garbage bytes
    writeFileSync(dbFile, "GARBAGE_BYTES_CORRUPTING_THE_DB");

    // Open connection again (will catch corruption and restore from shadow backup automatically!)
    const corruptBackend = getDb(dbFile, dbFile);
    const corruptSupervisor = new RecoverySupervisor(corruptBackend, dbFile, shadowFile);

    // Verification check should pass as database is already recovered
    const healthy = corruptSupervisor.verifyAndRestore();
    expect(healthy).toBe(true); 

    const restoredStore = new EpisodicStore(corruptBackend);
    const episodes = restoredStore.getEpisodes("session-a");

    expect(episodes.length).toBe(1);
    expect(episodes[0]!.content).toBe("Sample Content");
  });

  it("should quarantine vectors that fail dimension limits", () => {
    const backend = getDb(":memory:", ":memory:");
    const supervisor = new Supervisor(backend);

    const corruptVector = [1.0, 0.0, 0.0];
    supervisor.quarantineCorruptVector("symbol-corrupt", corruptVector, "Dimension size mismatch");

    // Verify record was inserted into quarantined_vectors table
    const stmt = (backend as any).db.prepare("SELECT * FROM quarantined_vectors WHERE id = ?");
    const record = stmt.get("symbol-corrupt");

    expect(record).toBeDefined();
    expect(record.error).toBe("Dimension size mismatch");
    expect(JSON.parse(record.vector)).toEqual(corruptVector);

    closeAllDbs();
  });
});
