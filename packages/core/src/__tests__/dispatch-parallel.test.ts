import { describe, expect, it, vi } from "vitest";
import { executeTurnToolBatch } from "../chat/turn-loop.js";
import { createTurnCircuitBreaker, isFileWritingTool, truncateToolResult } from "../skill/tool-harness.js";

const baseOpts = {
  projectRoot: process.cwd(),
  sessionId: "test-session",
  prompt: "test",
  loopCount: 1,
  isFileWritingTool,
  executeTool: vi.fn().mockResolvedValue("ok"),
  truncateToolResult,
};

describe("dispatch_parallel turn-loop barrier", () => {
  it("rejects mixed dispatch_parallel and other tools", async () => {
    const executeDispatchParallel = vi.fn();
    const result = await executeTurnToolBatch({
      ...baseOpts,
      toolCalls: [
        { name: "dispatch_parallel", arguments: { tasks: "[]" } },
        { name: "read_file", arguments: { path: "x.ts" } },
      ],
      executeDispatchParallel,
    });

    expect(result).toContain("dispatch_parallel must run alone");
    expect(executeDispatchParallel).not.toHaveBeenCalled();
  });

  it("returns a clear error for empty task list without calling execute", async () => {
    const executeDispatchParallel = vi.fn();
    const result = await executeTurnToolBatch({
      ...baseOpts,
      toolCalls: [{
        name: "dispatch_parallel",
        arguments: { tasks: "[]" },
      }],
      executeDispatchParallel,
    });

    expect(executeDispatchParallel).not.toHaveBeenCalled();
    expect(result).toContain("at least one");
  });

  it("routes dispatch_parallel through executeDispatchParallel callback", async () => {
    const executeDispatchParallel = vi.fn().mockResolvedValue("Exit Code: 0\nStdout:\nok");
    await executeTurnToolBatch({
      ...baseOpts,
      toolCalls: [{
        name: "dispatch_parallel",
        arguments: {
          tasks: JSON.stringify([{ agentId: "planner", task: "Plan A", label: "Plan A" }]),
        },
      }],
      executeDispatchParallel,
    });

    expect(executeDispatchParallel).toHaveBeenCalledOnce();
  });
});
