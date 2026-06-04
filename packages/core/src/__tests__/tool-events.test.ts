import { describe, it, expect } from "vitest";
import { classifyTool, toolTarget, toolResultIsFailure } from "../chat/tool-events.js";

describe("tool-events classifier (Phase A)", () => {
  it("classifies fs / exec / search / agent / memory tools", () => {
    expect(classifyTool("write_file")).toEqual({ category: "fs", action: "write" });
    expect(classifyTool("append_file")).toEqual({ category: "fs", action: "write" });
    expect(classifyTool("read_file")).toEqual({ category: "fs", action: "read" });
    expect(classifyTool("edit_file")).toEqual({ category: "fs", action: "edit" });
    expect(classifyTool("batch_edit")).toEqual({ category: "fs", action: "edit" });
    expect(classifyTool("delete_file")).toEqual({ category: "fs", action: "delete" });
    expect(classifyTool("move_file")).toEqual({ category: "fs", action: "move" });
    expect(classifyTool("execute_command")).toEqual({ category: "exec", action: "exec" });
    expect(classifyTool("grep_search")).toEqual({ category: "search", action: "search" });
    expect(classifyTool("dispatch_subagent")).toEqual({ category: "agent", action: "dispatch" });
    expect(classifyTool("remember")).toEqual({ category: "memory", action: "remember" });
    expect(classifyTool("forget")).toEqual({ category: "memory", action: "delete" });
    expect(classifyTool("something_else")).toEqual({ category: "other", action: "other" });
  });

  it("derives a human target (path / command / worker / pattern)", () => {
    expect(toolTarget("write_file", { path: "src/a.ts" })).toBe("src/a.ts");
    expect(toolTarget("read_file", { AbsolutePath: "/x/y.ts" })).toBe("/x/y.ts");
    expect(toolTarget("execute_command", { command: "npm run build" })).toBe("npm run build");
    expect(toolTarget("dispatch_subagent", { agentId: "frontend" })).toBe("worker.frontend");
    expect(toolTarget("dispatch_subagent", {})).toBe("subagent");
    expect(toolTarget("grep_search", { pattern: "TODO" })).toBe("TODO");
  });

  it("truncates long targets", () => {
    const long = "a/".repeat(300);
    expect(toolTarget("write_file", { path: long }).length).toBeLessThanOrEqual(200);
    expect(toolTarget("execute_command", { command: "x".repeat(300) }).length).toBeLessThanOrEqual(120);
  });

  it("treats Error… and non-zero Exit Code as failure (display truth)", () => {
    expect(toolResultIsFailure("Error: boom")).toBe(true);
    expect(toolResultIsFailure("Error\nstack")).toBe(true);
    expect(toolResultIsFailure("Exit Code: 1\nStderr: nope")).toBe(true);
    expect(toolResultIsFailure("Exit Code: 127")).toBe(true);
    expect(toolResultIsFailure("Exit Code: 0\nStdout: ok")).toBe(false);
    expect(toolResultIsFailure("42 bytes written")).toBe(false);
    expect(toolResultIsFailure("No files found")).toBe(false);
  });
});
