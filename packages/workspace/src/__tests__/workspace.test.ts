import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LockManager } from "../lock-manager.js";
import { StagingEngine } from "../staging-engine.js";
import { RecoveryEngine } from "../recovery-engine.js";

describe("packages/workspace", () => {
  let tempRoot: string;

  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), "agency-workspace-test-"));
  });

  afterEach(() => {
    if (existsSync(tempRoot)) {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  describe("LockManager", () => {
    it("can acquire and release a free lock", async () => {
      const lm = new LockManager();
      const acquired = await lm.acquireLock("file1.ts", "agent1");
      expect(acquired).toBe(true);
      expect(lm.isLocked("file1.ts")).toBe(true);
      expect(lm.getLock("file1.ts")?.workerId).toBe("agent1");

      lm.releaseLock("file1.ts", "agent1");
      expect(lm.isLocked("file1.ts")).toBe(false);
    });

    it("prevents concurrent lock acquisition and queue requests", async () => {
      const lm = new LockManager();
      // Lock by agent1
      await lm.acquireLock("file1.ts", "agent1", 5000);

      // Try lock by agent2 with 100ms timeout
      const acquiredPromise = lm.acquireLock("file1.ts", "agent2", 100);
      
      const acquiredByAgent2 = await acquiredPromise;
      expect(acquiredByAgent2).toBe(false); // Should timeout
    });

    it("successfully hands lock to queued worker when released", async () => {
      const lm = new LockManager();
      await lm.acquireLock("file1.ts", "agent1", 5000);

      const agent2LockPromise = lm.acquireLock("file1.ts", "agent2", 2000);

      // Release by agent1
      lm.releaseLock("file1.ts", "agent1");

      const acquiredByAgent2 = await agent2LockPromise;
      expect(acquiredByAgent2).toBe(true);
      expect(lm.getLock("file1.ts")?.workerId).toBe("agent2");
    });
  });

  describe("StagingEngine", () => {
    it("can stage files and commit transactions to disk", async () => {
      const se = new StagingEngine();
      se.startTransaction("tx1");

      writeFileSync(join(tempRoot, "existing.ts"), "original-content", "utf8");

      se.stageFile("tx1", "existing.ts", "original-content", "updated-content");
      se.stageFile("tx1", "newfile.ts", null, "brand-new-content");

      const staged = se.getStagedChanges("tx1");
      expect(staged?.size).toBe(2);
      expect(staged?.get("existing.ts")?.stagedContent).toBe("updated-content");

      // Commit
      const committed = await se.commitTransaction("tx1", tempRoot);
      expect(committed).toContain("existing.ts");
      expect(committed).toContain("newfile.ts");

      expect(readFileSync(join(tempRoot, "existing.ts"), "utf8")).toBe("updated-content");
      expect(readFileSync(join(tempRoot, "newfile.ts"), "utf8")).toBe("brand-new-content");
    });

    it("can discard a transaction without modifying the file system", async () => {
      const se = new StagingEngine();
      se.startTransaction("tx2");

      writeFileSync(join(tempRoot, "existing2.ts"), "original", "utf8");
      se.stageFile("tx2", "existing2.ts", "original", "changed");

      se.discardTransaction("tx2");
      expect(readFileSync(join(tempRoot, "existing2.ts"), "utf8")).toBe("original");
    });
  });

  describe("RecoveryEngine", () => {
    it("can backup and restore files on validation failure", async () => {
      const re = new RecoveryEngine();

      const file1 = join(tempRoot, "file1.ts");
      writeFileSync(file1, "version1", "utf8");

      // Create backup
      const backupPath = await re.createBackup(tempRoot, ["file1.ts", "missing.ts"]);
      expect(existsSync(backupPath)).toBe(true);

      // Corrupt file
      writeFileSync(file1, "corrupted-version", "utf8");

      // Restore
      await re.restoreBackup(tempRoot, backupPath);

      expect(readFileSync(file1, "utf8")).toBe("version1");
      expect(existsSync(join(tempRoot, "missing.ts"))).toBe(false);

      re.cleanBackup(backupPath);
      expect(existsSync(backupPath)).toBe(false);
    });
  });
});
