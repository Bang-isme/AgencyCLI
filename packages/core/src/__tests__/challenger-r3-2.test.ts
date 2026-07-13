import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseToolCalls, hasUnclosedToolCall, executeTool } from "../skill/tool-harness.js";
import { runPlan } from "../task/runner.js";
import { saveCheckpoint, loadCheckpoint } from "../task/checkpoint.js";
import { globalLeaseManager } from "../task/runner.js";

// Helper to create a temp directory
function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "agency-challenger-r3-2-"));
}

describe("R3 Challenger - Tool Call Salvaging & XML Parser", () => {
  it("verifies word boundary check \\b_call in tool call salvaging", () => {
    // 1. Matches _call name="..." when XML parse fails
    const matchText = `_call name="read_file">`;
    const matchCalls = parseToolCalls(matchText);
    expect(matchCalls).toHaveLength(1);
    expect(matchCalls[0]!.name).toBe("read_file");

    // 2. Does NOT match tool_call name="..." as salvage when XML parse fails
    const noMatchText = `tool_call name="read_file">`;
    const noMatchCalls = parseToolCalls(noMatchText);
    expect(noMatchCalls).toHaveLength(0);
  });

  it("handles unclosed tags and minimax/function_calls XML", () => {
    // Standard minimax:tool_call
    const minimaxText = `
<minimax:tool_call name="read_file">
  <path>src/index.ts</path>
</minimax:tool_call>
`;
    const minimaxCalls = parseToolCalls(minimaxText);
    expect(minimaxCalls).toHaveLength(1);
    expect(minimaxCalls[0]!.name).toBe("read_file");
    expect(minimaxCalls[0]!.arguments).toEqual({ path: "src/index.ts" });

    // Function calls
    const funcCallsText = `
<function_calls>
  <function_call name="list_dir">
    <path>.</path>
  </function_call>
</function_calls>
`;
    const funcCalls = parseToolCalls(funcCallsText);
    expect(funcCalls).toHaveLength(1);
    expect(funcCalls[0]!.name).toBe("list_dir");
    expect(funcCalls[0]!.arguments).toEqual({ path: "." });

    // Unclosed minimax:tool_call tag
    const unclosedMinimax = `<minimax:tool_call name="write_file"><path>foo.ts</path>`;
    expect(hasUnclosedToolCall(unclosedMinimax)).toBe(true);

    // Unclosed function_call tag - does hasUnclosedToolCall handle it?
    const unclosedFuncCall = `<function_call name="write_file"><path>foo.ts</path>`;
    // Extended hasUnclosedToolCall supports function_call and function_calls.
    expect(hasUnclosedToolCall(unclosedFuncCall)).toBe(true);
  });
});

describe("R3 Challenger - Task Runner Timeouts and Heartbeats", () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = makeTempDir();
  });

  afterEach(() => {
    if (projectRoot) {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it("verifies timeoutMs dynamically restored from state nodes triggers failure and cancels heartbeat lease", async () => {
    const planPath = join(projectRoot, "plan.md");
    writeFileSync(planPath, `# Plan\n### Task 1: Test\n- [ ] do test\n`, "utf8");

    const runId = "runner-timeout-challenge-test";
    
    // Save checkpoint with node having short timeoutMs (e.g. 50ms)
    saveCheckpoint(projectRoot, {
      id: runId,
      planPath,
      currentTask: 1,
      completed: [],
      status: "paused",
      updatedAt: new Date().toISOString(),
      harness: false,
      dagState: {
        nodes: {
          "task-1": { state: "PENDING", attempts: 0, timeoutMs: 50, action: "do test", id: "task-1", dependencies: [] }
        }
      }
    });

    const setIntervalSpy = vi.spyOn(global, "setInterval");
    const clearIntervalSpy = vi.spyOn(global, "clearInterval");
    const reclaimLeaseSpy = vi.spyOn(globalLeaseManager, "reclaimLease");

    // Task that runs longer than timeoutMs
    const runPromise = runPlan(projectRoot, "", {
      taskId: runId,
      onTask: async () => {
        await new Promise((r) => setTimeout(r, 200));
      }
    });

    await expect(runPromise).rejects.toThrow("timeout limit");

    // Verify lease was acquired and then reclaimed
    expect(reclaimLeaseSpy).toHaveBeenCalledWith("task-1");

    // Verify that setInterval was called and subsequently clearInterval was called
    expect(setIntervalSpy).toHaveBeenCalled();
    expect(clearIntervalSpy).toHaveBeenCalled();

    // Verify that the node state in checkpoint is transitioned to FAILED
    const cp = loadCheckpoint(projectRoot, runId);
    expect(cp?.dagState?.nodes?.["task-1"]?.state).toBe("FAILED");

    setIntervalSpy.mockRestore();
    clearIntervalSpy.mockRestore();
    reclaimLeaseSpy.mockRestore();
  });
});

describe("R3 Challenger - File Truncation Prevention Gate", () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = makeTempDir();
  });

  afterEach(() => {
    if (projectRoot) {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it("blocks writing truncated content to large files but allows valid or small rewrites", async () => {
    const largeFilePath = join(projectRoot, "large_file.ts");
    
    // 1. Create a large existing file (120 lines, ~6 KB)
    const largeLines = Array.from({ length: 120 }, (_, i) => `// Line ${i} of our very long file. It needs to exceed 5KB. `.repeat(2)).join("\n");
    writeFileSync(largeFilePath, largeLines, "utf8");

    // 2. Attempt to overwrite with truncated content (5 lines, <1 KB)
    const truncatedContent = "const short = 'truncated';\n";
    const resTruncated = await executeTool(
      "write_file",
      { path: "large_file.ts", content: truncatedContent },
      projectRoot
    );

    // Expect prevention gate to block it
    expect(resTruncated).toContain("Error: Large file detected");
    // Verify the file content on disk remains unchanged
    expect(readFileSync(largeFilePath, "utf8")).toBe(largeLines);

    // 3. Attempt to overwrite with comparable content (110 lines, similar line content/size)
    const comparableContent = Array.from({ length: 110 }, (_, i) => `// Line ${i} of our very long file. It needs to exceed 5KB. `.repeat(2)).join("\n");
    const resComparable = await executeTool(
      "write_file",
      { path: "large_file.ts", content: comparableContent },
      projectRoot
    );

    // Expect it to succeed (not containing Error: Large file detected)
    expect(resComparable).not.toContain("Error:");
    expect(readFileSync(largeFilePath, "utf8")).toBe(comparableContent);

    // 4. Overwrite a small file (should not block)
    const smallFilePath = join(projectRoot, "small_file.ts");
    const smallContent = "// line 1\n// line 2\n";
    writeFileSync(smallFilePath, smallContent, "utf8");

    const resSmall = await executeTool(
      "write_file",
      { path: "small_file.ts", content: "hello" },
      projectRoot
    );
    expect(resSmall).not.toContain("Error:");
    expect(readFileSync(smallFilePath, "utf8")).toBe("hello");
  });
});
