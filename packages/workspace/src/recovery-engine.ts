import { existsSync, writeFileSync, mkdirSync, rmSync, cpSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { execa } from "execa";

export class RecoveryEngine {
  /**
   * Creates a backup directory containing original copies of the specified files.
   * Returns the absolute path of the backup directory.
   */
  public async createBackup(projectRoot: string, filePaths: string[]): Promise<string> {
    const uuid = randomUUID();
    const backupDir = join(tmpdir(), "agency-workspace-recovery", uuid);
    mkdirSync(backupDir, { recursive: true });

    // Save mapping.json listing which files are backed up
    const mapping: Record<string, string> = {};

    for (const relPath of filePaths) {
      const src = join(projectRoot, relPath);
      if (existsSync(src)) {
        const dest = join(backupDir, relPath);
        mkdirSync(dirname(dest), { recursive: true });
        cpSync(src, dest);
        mapping[relPath] = "exists";
      } else {
        mapping[relPath] = "created";
      }
    }

    writeFileSync(join(backupDir, "mapping.json"), JSON.stringify(mapping, null, 2), "utf8");
    return backupDir;
  }

  /**
   * Restores files from a backup directory.
   */
  public async restoreBackup(projectRoot: string, backupPath: string): Promise<void> {
    const mapFile = join(backupPath, "mapping.json");
    if (!existsSync(mapFile)) {
      throw new Error(`Invalid backup path: mapping.json not found.`);
    }

    const mapping = JSON.parse(readFileSync(mapFile, "utf8")) as Record<string, string>;

    for (const [relPath, status] of Object.entries(mapping)) {
      const dest = join(projectRoot, relPath);

      if (status === "created") {
        // File was created during transaction, so delete it to restore original state
        if (existsSync(dest)) {
          rmSync(dest, { force: true, recursive: true });
        }
      } else {
        // File existed originally, restore it
        const src = join(backupPath, relPath);
        if (existsSync(src)) {
          mkdirSync(dirname(dest), { recursive: true });
          cpSync(src, dest, { force: true });
        }
      }
    }
  }

  /**
   * Clean up the temporary backup directory.
   */
  public cleanBackup(backupPath: string): void {
    if (existsSync(backupPath)) {
      rmSync(backupPath, { recursive: true, force: true });
    }
  }

  /**
   * Git rollback fallback in case of catastrophic corruption when staging is bypassed.
   */
  public async gitRollback(projectRoot: string): Promise<void> {
    try {
      await execa("git", ["checkout", "."], { cwd: projectRoot });
      await execa("git", ["clean", "-fd"], { cwd: projectRoot });
    } catch (err) {
      throw new Error(`Git rollback failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Verifies codebase integrity by performing a fast syntax check or linter validation.
   */
  public async verifyIntegrity(
    projectRoot: string,
    command: string[]
  ): Promise<{ success: boolean; error?: string }> {
    if (command.length === 0) return { success: true };
    const [bin, ...args] = command;

    try {
      const res = await execa(bin!, args, { cwd: projectRoot, reject: false });
      return {
        success: res.exitCode === 0,
        error: res.exitCode === 0 ? undefined : `Exit code ${res.exitCode}: ${res.stderr || res.stdout}`,
      };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}
