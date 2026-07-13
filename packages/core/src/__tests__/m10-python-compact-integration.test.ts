import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, existsSync, readdirSync, readFileSync, rmSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { compactContext } from "../memory/compact.js";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "../../../..");
const SKILLS_ROOT = join(ROOT, "packages", "cli", "skills");

describe("Milestone 10 Challenger: Python Context Compactor Integration", () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = join(tmpdir(), `agency-test-compact-${Date.now()}-${Math.random().toString(36).substring(7)}`);
    mkdirSync(projectRoot, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(projectRoot)) {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it("performs end-to-end dry-run and mutating compaction on mock memory files", async () => {
    // 1. Setup mock directories
    const sessionsDir = join(projectRoot, ".codex", "sessions");
    const feedbackDir = join(projectRoot, ".codex", "feedback");
    const decisionsDir = join(projectRoot, ".codex", "decisions");

    mkdirSync(sessionsDir, { recursive: true });
    mkdirSync(feedbackDir, { recursive: true });
    mkdirSync(decisionsDir, { recursive: true });

    // 2. Create mock decisions
    writeFileSync(join(decisionsDir, "dec-1.md"), "# Decision 1\n");
    writeFileSync(join(decisionsDir, "dec-2.md"), "# Decision 2\n");

    // 3. Create mock sessions
    const today = new Date();
    
    // Create 5 recent sessions (keepLatest = 5)
    for (let i = 0; i < 5; i++) {
      const d = new Date(today);
      d.setDate(today.getDate() - i);
      const dateStr = d.toISOString().split("T")[0];
      writeFileSync(
        join(sessionsDir, `${dateStr}-sess.md`),
        `# Session Summary: ${dateStr}\n\n- Commits: 2\n- Files changed: 3\n\n## Changes Made\n- Added helper function\n- Fixed minor bug\n`
      );
    }

    // Create 3 old sessions (older than 90 days)
    const oldDates = ["2025-01-10", "2025-01-11", "2025-01-12"];
    const oldMtime = new Date();
    oldMtime.setDate(today.getDate() - 100); // 100 days ago
    for (const dateStr of oldDates) {
      const filePath = join(sessionsDir, `${dateStr}-sess.md`);
      writeFileSync(
        filePath,
        `# Session Summary: ${dateStr}\n\n- Commits: 1\n- Files changed: 1\n\n## Changes Made\n- Cleaned up config files\n`
      );
      utimesSync(filePath, oldMtime, oldMtime);
    }

    // 4. Create mock feedback entries
    for (let i = 1; i <= 55; i++) {
      const category = i % 3 === 0 ? "lint" : i % 3 === 1 ? "types" : "runtime";
      writeFileSync(
        join(feedbackDir, `2025-02-${String(i).padStart(2, "0")}-fb.md`),
        `Date: 2025-02-15\nCategory: ${category}\n\n## Lesson Learned\nAlways import with .js extension\n`
      );
    }

    // --- DRY RUN TEST ---
    const dryRunResult = await compactContext(SKILLS_ROOT, projectRoot, {
      dryRun: true,
      maxAgeDays: 90,
      keepLatest: 5,
    });

    expect(dryRunResult.exitCode).toBe(0);
    const dryRunJson = JSON.parse(dryRunResult.stdout);
    expect(dryRunJson.status).toBe("compacted");
    expect(dryRunJson.sessions_archived).toBe(3);
    expect(dryRunJson.feedback_archived).toBe(55);
    expect(dryRunJson.decisions_kept).toBe(2);
    expect(dryRunJson.bytes_freed).toBeGreaterThan(0);

    // Verify dry-run didn't delete/create files
    const dryRunSessions = readdirSync(sessionsDir).filter(f => f.endsWith(".md"));
    expect(dryRunSessions.length).toBe(8);
    expect(existsSync(join(sessionsDir, "archive"))).toBe(false);

    const dryRunFeedback = readdirSync(feedbackDir).filter(f => f.endsWith(".md"));
    expect(dryRunFeedback.length).toBe(55);
    expect(existsSync(join(feedbackDir, "archive"))).toBe(false);

    // --- MUTATING COMPACTION TEST ---
    const compactResult = await compactContext(SKILLS_ROOT, projectRoot, {
      yes: true,
      maxAgeDays: 90,
      keepLatest: 5,
    });

    expect(compactResult.exitCode).toBe(0);
    const compactJson = JSON.parse(compactResult.stdout);
    expect(compactJson.status).toBe("compacted");
    expect(compactJson.sessions_archived).toBe(3);
    expect(compactJson.feedback_archived).toBe(55);
    expect(compactJson.decisions_kept).toBe(2);
    expect(compactJson.bytes_freed).toBe(dryRunJson.bytes_freed);

    // Verify mutating compaction deleted archived sessions
    const postSessions = readdirSync(sessionsDir).filter(f => f.endsWith(".md"));
    expect(postSessions.length).toBe(5);

    // Verify session archive was created
    const sessionArchiveDir = join(sessionsDir, "archive");
    expect(existsSync(sessionArchiveDir)).toBe(true);
    const sessionArchiveFiles = readdirSync(sessionArchiveDir);
    expect(sessionArchiveFiles.length).toBe(1);
    expect(sessionArchiveFiles[0]).toBe("2025-summary.md");

    const sessionArchiveContent = readFileSync(join(sessionArchiveDir, "2025-summary.md"), "utf-8");
    expect(sessionArchiveContent).toContain("# Session Archive: 2025");
    expect(sessionArchiveContent).toContain("2025-01-10");
    expect(sessionArchiveContent).toContain("Cleaned up config files");

    // Verify feedback entries were deleted
    const postFeedback = readdirSync(feedbackDir).filter(f => f.endsWith(".md"));
    expect(postFeedback.length).toBe(0);

    // Verify feedback archive was created
    const feedbackArchiveDir = join(feedbackDir, "archive");
    expect(existsSync(feedbackArchiveDir)).toBe(true);
    const feedbackArchiveFiles = readdirSync(feedbackArchiveDir);
    expect(feedbackArchiveFiles.length).toBe(1);
    expect(feedbackArchiveFiles[0]).toBe("2025-02-summary.md");

    const feedbackArchiveContent = readFileSync(join(feedbackArchiveDir, "2025-02-summary.md"), "utf-8");
    expect(feedbackArchiveContent).toContain("# Feedback Archive: 2025-02");
    expect(feedbackArchiveContent).toContain("Total entries: 55");
    expect(feedbackArchiveContent).toContain("Category Counts");
    expect(feedbackArchiveContent).toContain("lint:");
    expect(feedbackArchiveContent).toContain("types:");
    expect(feedbackArchiveContent).toContain("runtime:");
    expect(feedbackArchiveContent).toContain("Always import with .js extension");

    // Verify decisions were not deleted
    const postDecisions = readdirSync(decisionsDir).filter(f => f.endsWith(".md"));
    expect(postDecisions.length).toBe(2);
  }, 30000);
});
