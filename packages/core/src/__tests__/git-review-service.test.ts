import { describe, expect, it } from "vitest";
import { GitReviewService } from "../git/review-service.js";

describe("GitReviewService", () => {
  describe("sanitizeDiff", () => {
    it("filters out lockfiles and suppresses them", () => {
      const rawDiff = `diff --git a/pnpm-lock.yaml b/pnpm-lock.yaml
index 12345..67890 100644
--- a/pnpm-lock.yaml
+++ b/pnpm-lock.yaml
@@ -1,3 +1,4 @@
-oldLockContent
+newLockContent
diff --git a/src/index.ts b/src/index.ts
index abcde..fghij 100644
--- a/src/index.ts
+++ b/src/index.ts
@@ -1,2 +1,3 @@
 const x = 1;
+const y = 2;
`;
      const sanitized = GitReviewService.sanitizeDiff(rawDiff);
      expect(sanitized).toContain("[Diff suppressed for excluded file: pnpm-lock.yaml]");
      expect(sanitized).not.toContain("oldLockContent");
      expect(sanitized).toContain("const y = 2;");
    });
  });

  describe("formatReviewPrompt", () => {
    it("formats review context correctly as markdown", () => {
      const context = {
        summary: {
          available: true,
          branch: "main",
          isClean: false,
          staged: 1,
          unstaged: 2,
          untracked: 0,
          recentCommits: [],
          ghAvailable: false,
        },
        fileList: [
          { status: "M", path: "src/index.ts" },
          { status: "??", path: "test.ts" },
        ],
        stagedDiff: "stagedDiffContent",
        unstagedDiff: "unstagedDiffContent",
        truncated: false,
        estimatedTokens: 10,
      };

      const result = GitReviewService.formatReviewPrompt(context, "Review these changes.");
      expect(result).toContain("## Git Review Context");
      expect(result).toContain("Branch: `main`");
      expect(result).toContain("Staged: 1, Unstaged: 2, Untracked: 0");
      expect(result).toContain("- `[M]` src/index.ts");
      expect(result).toContain("stagedDiffContent");
      expect(result).toContain("unstagedDiffContent");
      expect(result).toContain("Review these changes.");
    });
  });
});
