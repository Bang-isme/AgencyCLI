import { execa } from "execa";
import { getGitSummary, getGitDiff, type GitSummary } from "./intelligence.js";

export interface ReviewOptions {
  projectRoot: string;
  mode?: "unstaged" | "staged" | "working_tree" | "commit" | "branch" | "pr";
  targetRef?: string;
  maxDiffChars?: number;
  excludePatterns?: string[];
}

export interface ReviewContext {
  summary: GitSummary;
  fileList: { status: string; path: string }[];
  stagedDiff?: string;
  unstagedDiff?: string;
  commitDiff?: string;
  truncated: boolean;
  estimatedTokens: number;
}

export class GitReviewService {
  /** Filters out binary files, lockfiles, and secrets from diff string */
  static sanitizeDiff(
    rawDiff: string,
    excludePatterns: string[] = ["pnpm-lock.yaml", "package-lock.json", "yarn.lock", ".env*"]
  ): string {
    if (!rawDiff) return "";
    const lines = rawDiff.split("\n");
    const result: string[] = [];
    let skipping = false;

    for (const line of lines) {
      if (line.startsWith("diff --git ")) {
        skipping = false;
        const match = line.match(/diff --git a\/(.+) b\/(.+)/);
        if (match) {
          const filePath = match[2]!;
          const normalizedPath = filePath.replace(/\\/g, "/");
          const shouldExclude = excludePatterns.some((pattern) => {
            const normalizedPattern = pattern.replace(/\\/g, "/");
            if (!normalizedPattern.includes("/")) {
              const filename = normalizedPath.split("/").pop() || "";
              const escaped = normalizedPattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
              const regexStr = "^" + escaped.replace(/\*/g, ".*").replace(/\?/g, ".") + "$";
              const regex = new RegExp(regexStr);
              return regex.test(filename);
            } else {
              let regexStr = normalizedPattern
                .replace(/[.+^${}()|[\]\\]/g, "\\$&")
                .replace(/\*\*\//g, "([^/]+/)*")
                .replace(/\*\*/g, ".*")
                .replace(/\*/g, "[^/]*")
                .replace(/\?/g, "[^/]");
              
              regexStr = "^" + regexStr + "$";
              const regex = new RegExp(regexStr);
              if (regex.test(normalizedPath)) {
                return true;
              }
              const suffixRegexStr = "(^|/)" + regexStr.slice(1);
              const suffixRegex = new RegExp(suffixRegexStr);
              return suffixRegex.test(normalizedPath);
            }
          });
          if (shouldExclude) {
            skipping = true;
            result.push(`[Diff suppressed for excluded file: ${filePath}]`);
            continue;
          }
        }
      }

      if (!skipping) {
        result.push(line);
      }
    }

    return result.join("\n");
  }

  /** Gathers unified git summary and textual diffs according to mode */
  static async buildReviewContext(options: ReviewOptions): Promise<ReviewContext> {
    const {
      projectRoot,
      mode = "working_tree",
      targetRef,
      maxDiffChars = 32_000,
      excludePatterns = ["pnpm-lock.yaml", "package-lock.json", "yarn.lock", ".env*"],
    } = options;

    const summary = await getGitSummary(projectRoot);

    const statusResult = await execa("git", ["status", "--porcelain"], {
      cwd: projectRoot,
      reject: false,
      timeout: 3000,
    });
    const fileList: { status: string; path: string }[] = [];
    if (statusResult.exitCode === 0 && statusResult.stdout.trim()) {
      for (const line of statusResult.stdout.split("\n").filter((l) => l.trim())) {
        const status = line.slice(0, 2).trim();
        const path = line.slice(3).trim();
        fileList.push({ status, path });
      }
    }

    let stagedDiff: string | undefined;
    let unstagedDiff: string | undefined;
    let commitDiff: string | undefined;
    let truncated = false;

    if (mode === "staged" || mode === "working_tree") {
      const res = await getGitDiff(projectRoot, true, maxDiffChars);
      stagedDiff = this.sanitizeDiff(res.diff, excludePatterns);
      if (res.truncated) truncated = true;
    }

    if (mode === "unstaged" || mode === "working_tree") {
      const res = await getGitDiff(projectRoot, false, maxDiffChars);
      unstagedDiff = this.sanitizeDiff(res.diff, excludePatterns);
      if (res.truncated) truncated = true;
    }

    if (mode === "commit" || mode === "branch" || mode === "pr") {
      const ref = targetRef || (mode === "commit" ? "HEAD~1" : "main");
      const gitArgs = mode === "commit" ? ["show", ref] : ["diff", `${ref}...HEAD`];
      const res = await execa("git", gitArgs, {
        cwd: projectRoot,
        reject: false,
        timeout: 5000,
      });
      if (res.exitCode === 0) {
        const raw = res.stdout;
        commitDiff = this.sanitizeDiff(raw.slice(0, maxDiffChars), excludePatterns);
        if (raw.length > maxDiffChars) truncated = true;
      }
    }

    const totalChars =
      (stagedDiff?.length ?? 0) +
      (unstagedDiff?.length ?? 0) +
      (commitDiff?.length ?? 0);
    const estimatedTokens = Math.ceil(totalChars / 4);

    return {
      summary,
      fileList,
      stagedDiff,
      unstagedDiff,
      commitDiff,
      truncated,
      estimatedTokens,
    };
  }

  /** Formats ReviewContext into a markdown block ready for LLM prompt prepending */
  static formatReviewPrompt(context: ReviewContext, userPrompt?: string): string {
    const lines: string[] = [];
    lines.push("## Git Review Context");
    lines.push(`- Branch: \`${context.summary.branch}\``);
    lines.push(
      `- Status: ${
        context.summary.isClean
          ? "Clean working tree"
          : `Staged: ${context.summary.staged}, Unstaged: ${context.summary.unstaged}, Untracked: ${context.summary.untracked}`
      }`
    );

    if (context.fileList.length > 0) {
      lines.push("\n### Changed Files:");
      for (const f of context.fileList) {
        lines.push(`- \`[${f.status}]\` ${f.path}`);
      }
    }

    if (context.stagedDiff) {
      lines.push("\n### Staged Changes Diff:");
      lines.push("```diff");
      lines.push(context.stagedDiff);
      lines.push("```");
    }

    if (context.unstagedDiff) {
      lines.push("\n### Unstaged Changes Diff:");
      lines.push("```diff");
      lines.push(context.unstagedDiff);
      lines.push("```");
    }

    if (context.commitDiff) {
      lines.push("\n### Commit / Target Diff:");
      lines.push("```diff");
      lines.push(context.commitDiff);
      lines.push("```");
    }

    if (context.truncated) {
      lines.push("\n*(Note: Diff output was truncated to fit character/token limits)*");
    }

    if (userPrompt) {
      lines.push(`\n### Review Task:\n${userPrompt}`);
    }

    return lines.join("\n");
  }
}
