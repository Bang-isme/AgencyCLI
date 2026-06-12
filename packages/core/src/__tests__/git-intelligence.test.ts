import { execaSync } from "execa";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

const GIT_AVAILABLE = (() => {
  try {
    return execaSync("git", ["--version"], { reject: false }).exitCode === 0;
  } catch {
    return false;
  }
})();

const REPO_ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "../../../..");
const IS_GIT_REPO = existsSync(join(REPO_ROOT, ".git"));

describe("getGitSummary", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.skipIf(!IS_GIT_REPO)(
    "returns git summary for AgencyCLI repo",
    async () => {
      const { getGitSummary } = await import("../git/intelligence.js");
      const summary = await getGitSummary(REPO_ROOT);

      expect(summary.branch).toBeTruthy();
      expect(typeof summary.isClean).toBe("boolean");
      expect(summary.staged).toBeGreaterThanOrEqual(0);
      expect(summary.unstaged).toBeGreaterThanOrEqual(0);
      expect(summary.untracked).toBeGreaterThanOrEqual(0);
      expect(Array.isArray(summary.recentCommits)).toBe(true);
      expect(typeof summary.ghAvailable).toBe("boolean");

      if (summary.recentCommits.length > 0) {
        expect(summary.recentCommits[0].hash).toBeTruthy();
        expect(typeof summary.recentCommits[0].subject).toBe("string");
      }
    },
    15000
  );

  it.skipIf(!GIT_AVAILABLE)(
    "detects the branch name on an unborn HEAD (repo with no commits)",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "agency-git-unborn-"));
      try {
        execaSync("git", ["init"], { cwd: dir });
        // Force a deterministic branch name regardless of the host's
        // init.defaultBranch setting, without creating any commit.
        execaSync("git", ["symbolic-ref", "HEAD", "refs/heads/probe-branch"], {
          cwd: dir,
        });

        const { getGitSummary } = await import("../git/intelligence.js");
        const summary = await getGitSummary(dir);

        expect(summary.branch).toBe("probe-branch");
        expect(summary.recentCommits).toEqual([]);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    15000
  );
});
