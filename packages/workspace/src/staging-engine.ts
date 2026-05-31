import { existsSync, writeFileSync, mkdirSync, rmSync, cpSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { execa } from "execa";
import { WorkspaceTransaction, StagedChange } from "./types.js";
import { commitMutationsAtomic, type MutationEntry } from "./mutation-journal.js";

export class StagingEngine {
  private transactions = new Map<string, WorkspaceTransaction>();

  /**
   * Starts a new transaction for virtual staging.
   */
  public startTransaction(txId: string): void {
    if (this.transactions.has(txId)) {
      throw new Error(`Transaction ${txId} already active.`);
    }

    this.transactions.set(txId, {
      id: txId,
      stagedChanges: new Map<string, StagedChange>(),
      status: "active",
    });
  }

  /**
   * Stages a file modification in memory.
   */
  public stageFile(
    txId: string,
    filePath: string,
    originalContent: string | null,
    stagedContent: string | null
  ): void {
    const tx = this.transactions.get(txId);
    if (!tx || tx.status !== "active") {
      throw new Error(`Transaction ${txId} is not active.`);
    }

    tx.stagedChanges.set(filePath, {
      relativePath: filePath,
      originalContent,
      stagedContent,
      timestamp: Date.now(),
    });
  }

  /**
   * Discards all staged changes within a transaction.
   */
  public discardTransaction(txId: string): void {
    const tx = this.transactions.get(txId);
    if (tx) {
      tx.status = "rolled_back";
      this.transactions.delete(txId);
    }
  }

  /**
   * Returns all active staged changes for a transaction.
   */
  public getStagedChanges(txId: string): Map<string, StagedChange> | undefined {
    return this.transactions.get(txId)?.stagedChanges;
  }

  /**
   * Runs compile or verification commands inside a temporary shadow-workspace.
   * Merges staged changes into the shadow copy, runs commands, and returns result.
   */
  public async verifyTransaction(
    txId: string,
    projectRoot: string,
    verifyCommands: string[][] = [["pnpm", "build"]]
  ): Promise<{ success: boolean; errors: string[] }> {
    const tx = this.transactions.get(txId);
    if (!tx || tx.status !== "active") {
      return { success: false, errors: [`Transaction ${txId} is not active.`] };
    }

    if (tx.stagedChanges.size === 0) {
      return { success: true, errors: [] }; // Nothing to verify
    }

    const uuid = randomUUID();
    const tempWorkspace = join(tmpdir(), "agency-staging-verify", `${txId}-${uuid}`);

    try {
      // 1. Create a shadow copy of the active project (excluding heavy directories)
      const EXCLUDE_LIST = ["node_modules", ".git", ".agency", "dist", "build"];
      mkdirSync(tempWorkspace, { recursive: true });
      
      cpSync(projectRoot, tempWorkspace, {
        recursive: true,
        filter: (srcPath) => {
          const rel = relative(projectRoot, srcPath);
          if (!rel) return true; // root itself
          const parts = rel.split(/[\\/]/);
          return !parts.some((part) => EXCLUDE_LIST.includes(part));
        },
      });

      // 2. Apply virtual staged changes to the shadow copy
      for (const [relPath, change] of tx.stagedChanges) {
        const dest = join(tempWorkspace, relPath);
        if (change.stagedContent === null) {
          // File deletion
          if (existsSync(dest)) {
            rmSync(dest, { force: true });
          }
        } else {
          // File write/creation
          mkdirSync(dirname(dest), { recursive: true });
          writeFileSync(dest, change.stagedContent, "utf8");
        }
      }

      // 3. Link node_modules from active workspace so we can run build/lint/test commands
      const activeNodeModules = join(projectRoot, "node_modules");
      const shadowNodeModules = join(tempWorkspace, "node_modules");
      if (existsSync(activeNodeModules)) {
        // Create a symlink or copy, symlink is far faster and uses zero space
        try {
          const fs = await import("node:fs/promises");
          await fs.symlink(activeNodeModules, shadowNodeModules, "junction");
        } catch {
          // fallback to copying package.json or using direct link
        }
      }

      // 4. Run each validation command sequentially
      const errors: string[] = [];
      for (const cmdArgs of verifyCommands) {
        if (cmdArgs.length === 0) continue;
        const [bin, ...args] = cmdArgs;

        const res = await execa(bin!, args, {
          cwd: tempWorkspace,
          reject: false,
        });

        if (res.exitCode !== 0) {
          errors.push(
            `Command "${cmdArgs.join(" ")}" failed with exit code ${res.exitCode}.\nStdout: ${res.stdout}\nStderr: ${res.stderr}`
          );
        }
      }

      return {
        success: errors.length === 0,
        errors,
      };
    } catch (err) {
      return {
        success: false,
        errors: [err instanceof Error ? err.message : String(err)],
      };
    } finally {
      // Clean up shadow copy
      try {
        rmSync(tempWorkspace, { recursive: true, force: true });
      } catch {
        // best effort
      }
    }
  }

  /**
   * Commits staged memory changes to the real project directory.
   */
  public async commitTransaction(txId: string, projectRoot: string): Promise<string[]> {
    const tx = this.transactions.get(txId);
    if (!tx || tx.status !== "active") {
      throw new Error(`Transaction ${txId} is not active.`);
    }

    const committedFiles: string[] = [];

    for (const [relPath, change] of tx.stagedChanges) {
      const dest = join(projectRoot, relPath);

      if (change.stagedContent === null) {
        // Delete file
        if (existsSync(dest)) {
          rmSync(dest, { force: true, recursive: true });
        }
      } else {
        // Write file (atomic write using temp and rename inside same volume if possible)
        const parentDir = dirname(dest);
        if (!existsSync(parentDir)) {
          mkdirSync(parentDir, { recursive: true });
        }

        const tempFile = dest + ".tmp." + Date.now();
        writeFileSync(tempFile, change.stagedContent, "utf8");

        try {
          const fs = await import("node:fs/promises");
          await fs.rename(tempFile, dest);
        } catch {
          writeFileSync(dest, change.stagedContent, "utf8");
          try { rmSync(tempFile, { force: true }); } catch {}
        }
      }

      committedFiles.push(relPath);
    }

    tx.status = "committed";
    this.transactions.delete(txId);
    return committedFiles;
  }

  /**
   * Crash-safe variant of {@link commitTransaction}: persists a mutation journal
   * (full before/after of every file) before touching disk, applies all changes,
   * rolls back inline on any write error, and clears the journal on success. If
   * the process dies mid-commit the `committing` journal survives so startup
   * recovery (`recoverPendingMutations`) can undo the partial write. Use this
   * when atomic rollback is required. Returns the committed relative paths.
   */
  public commitTransactionAtomic(txId: string, projectRoot: string): string[] {
    const tx = this.transactions.get(txId);
    if (!tx || tx.status !== "active") {
      throw new Error(`Transaction ${txId} is not active.`);
    }

    const mutations: MutationEntry[] = [];
    for (const [relPath, change] of tx.stagedChanges) {
      mutations.push({
        relativePath: relPath,
        originalContent: change.originalContent,
        stagedContent: change.stagedContent,
      });
    }

    const committed = commitMutationsAtomic(projectRoot, txId, mutations);
    tx.status = "committed";
    this.transactions.delete(txId);
    return committed;
  }
}
