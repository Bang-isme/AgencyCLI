import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeTool } from "../skill/tool-harness.js";
import { summarizeToolResult } from "../chat/turn-loop.js";
import { StagingEngine } from "@agency/workspace";

// Helper to create a temp directory
function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "agency-challenger-r3-1-"));
}

describe("R3 Challenger 1 - Directory reads on read_file and file_info", () => {
  it("should handle directory paths on read_file and return directory listings without EISDIR", async () => {
    const projectRoot = makeTempDir();
    try {
      // Create subfiles and folders inside projectRoot
      writeFileSync(join(projectRoot, "file1.txt"), "hello", "utf8");
      writeFileSync(join(projectRoot, "file2.txt"), "world", "utf8");

      const result = await executeTool(
        "read_file",
        { path: "." },
        projectRoot
      );

      expect(result).not.toContain("EISDIR");
      expect(result).toContain("Directory: .");
      expect(result).toContain("Entries: 2");
      expect(result).toContain("file1.txt");
      expect(result).toContain("file2.txt");
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it("should handle directory paths on file_info and return directory listings without EISDIR", async () => {
    const projectRoot = makeTempDir();
    try {
      writeFileSync(join(projectRoot, "test_file.txt"), "hello", "utf8");

      const result = await executeTool(
        "file_info",
        { path: "." },
        projectRoot
      );

      expect(result).not.toContain("EISDIR");
      expect(result).toContain("Directory: .");
      expect(result).toContain("Entries: 1");
      expect(result).toContain("test_file.txt");
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});

describe("R3 Challenger 1 - view_file results resultSummarizer redirection", () => {
  it("should summarize view_file result using read_file's summarizer", () => {
    const mockViewFileResult = "File: test.ts (45 lines total, showing 1-45)\n1: const a = 1;";
    const summary = summarizeToolResult("view_file", mockViewFileResult, { path: "test.ts" });
    expect(summary).toBe("45 lines");
  });

  it("should redirect view_file result to read_file summarizer (even without lines count format, returning line count)", () => {
    const mockViewFileResult = "some raw content";
    const summary = summarizeToolResult("view_file", mockViewFileResult, { path: "test.ts" });
    expect(summary).toBe("1 line");
  });

  it("should fallback to size-based summary for unknown tools", () => {
    const mockResult = "some raw content";
    const summary = summarizeToolResult("unknown_tool", mockResult, { path: "test.ts" });
    expect(summary).toBe("16 B");
  });
});

describe("R3 Challenger 1 - Abort/cancel signal propagation to stagingEngine.verifyTransaction and execa", () => {
  it("should propagate abort signal to verifyTransaction and terminate processes immediately", async () => {
    const projectRoot = makeTempDir();
    const stagingEngine = new StagingEngine();
    const txId = "tx-test-abort";

    try {
      // Setup transaction and fake staged file so verifyTransaction is not skipped
      stagingEngine.startTransaction(txId);
      stagingEngine.stageFile(txId, "dummy.txt", "old", "new");

      const controller = new AbortController();
      
      // We will run a validation command that hangs for 10 seconds unless aborted.
      // node -e "setTimeout(() => {}, 10000)"
      const verifyCommands = [["node", "-e", "setTimeout(() => {}, 10000)"]];

      const start = Date.now();

      // Start verification
      const verifyPromise = stagingEngine.verifyTransaction(
        txId,
        projectRoot,
        verifyCommands,
        controller.signal
      );

      // Abort after 100ms
      setTimeout(() => {
        controller.abort(new Error("Canceled by stress test"));
      }, 100);

      const result = await verifyPromise;
      const duration = Date.now() - start;

      // Verify that it finished much faster than 10 seconds (e.g. < 2 seconds)
      expect(duration).toBeLessThan(2000);
      expect(result.success).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors[0]).toContain("Canceled by stress test");
    } finally {
      stagingEngine.discardTransaction(txId);
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});
