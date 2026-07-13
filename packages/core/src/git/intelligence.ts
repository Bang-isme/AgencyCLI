import { execa } from "execa";

export interface GitSummary {
  available: boolean;
  branch: string;
  isClean: boolean;
  staged: number;
  unstaged: number;
  untracked: number;
  recentCommits: { hash: string; subject: string }[];
  ghAvailable: boolean;
}

export interface GitDiffResult {
  available: boolean;
  diff: string;
  staged: boolean;
  truncated: boolean;
  error?: string;
}

function parseStatusPorcelain(output: string): {
  staged: number;
  unstaged: number;
  untracked: number;
} {
  let staged = 0;
  let unstaged = 0;
  let untracked = 0;

  for (const line of output.split("\n").filter((l) => l.length > 0)) {
    if (line.startsWith("??")) {
      untracked++;
      continue;
    }
    const indexStatus = line[0];
    const workTreeStatus = line[1];
    if (indexStatus !== " " && indexStatus !== "?") staged++;
    if (workTreeStatus !== " " && workTreeStatus !== "?") unstaged++;
  }

  return { staged, unstaged, untracked };
}

function parseRecentCommits(
  output: string
): { hash: string; subject: string }[] {
  return output
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      const spaceIdx = line.indexOf(" ");
      if (spaceIdx === -1) {
        return { hash: line.trim(), subject: "" };
      }
      return {
        hash: line.slice(0, spaceIdx).trim(),
        subject: line.slice(spaceIdx + 1).trim(),
      };
    });
}

export async function getGitSummary(projectRoot: string): Promise<GitSummary> {
  const gitOpts = { cwd: projectRoot, reject: false, timeout: 3000 } as const;

  const [branchResult, statusResult, logResult, ghResult] = await Promise.all([
    // `symbolic-ref` resolves the branch even on an unborn HEAD (a freshly
    // `git init`-ed repo with no commits yet), where `rev-parse --abbrev-ref
    // HEAD` fails outright and would otherwise report the branch as "unknown".
    execa("git", ["symbolic-ref", "--quiet", "--short", "HEAD"], gitOpts),
    execa("git", ["status", "--porcelain"], gitOpts),
    execa("git", ["log", "-5", "--oneline"], gitOpts),
    execa("gh", ["--version"], { reject: false, timeout: 2000 }),
  ]);

  const available = statusResult.exitCode === 0;
  if (!available) {
    return {
      available: false,
      branch: "not a repository",
      isClean: false,
      staged: 0,
      unstaged: 0,
      untracked: 0,
      recentCommits: [],
      ghAvailable: ghResult.exitCode === 0,
    };
  }

  let branch: string;
  if (branchResult.exitCode === 0 && branchResult.stdout.trim()) {
    branch = branchResult.stdout.trim();
  } else {
    // Detached HEAD: symbolic-ref fails, so fall back to the short commit.
    const headResult = await execa(
      "git",
      ["rev-parse", "--short", "HEAD"],
      gitOpts
    );
    branch =
      headResult.exitCode === 0 && headResult.stdout.trim()
        ? `(detached: ${headResult.stdout.trim()})`
        : "unknown";
  }
  const statusText = statusResult.exitCode === 0 ? statusResult.stdout : "";
  const { staged, unstaged, untracked } = parseStatusPorcelain(statusText);
  const recentCommits =
    logResult.exitCode === 0 ? parseRecentCommits(logResult.stdout) : [];

  return {
    available,
    branch,
    isClean: statusText.trim().length === 0,
    staged,
    unstaged,
    untracked,
    recentCommits,
    ghAvailable: ghResult.exitCode === 0,
  };
}

/** One reusable git-diff boundary for TUI, tool harness, and future CLI review. */
export async function getGitDiff(
  projectRoot: string,
  staged = false,
  maxChars = 16_000
): Promise<GitDiffResult> {
  const result = await execa("git", ["diff", ...(staged ? ["--staged"] : [])], {
    cwd: projectRoot,
    reject: false,
    timeout: 5_000,
  });
  if (result.exitCode !== 0) {
    return {
      available: false,
      diff: "",
      staged,
      truncated: false,
      error: result.stderr.trim() || "Git diff is unavailable for this workspace.",
    };
  }
  const diff = result.stdout;
  return {
    available: true,
    diff: diff.slice(0, maxChars),
    staged,
    truncated: diff.length > maxChars,
  };
}
