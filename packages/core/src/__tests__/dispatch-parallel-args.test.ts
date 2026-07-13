import { describe, expect, it } from "vitest";
import {
  extractJsonArray,
  parseDispatchParallelTasks,
} from "../skill/dispatch-parallel-args.js";
import { parseToolCalls } from "../skill/tool-harness.js";

describe("parseDispatchParallelTasks", () => {
  it("parses tasks from a JSON string", () => {
    const result = parseDispatchParallelTasks({
      tasks: JSON.stringify([
        { agentId: "frontend-specialist", task: "Improve Hero.tsx", label: "Homepage" },
      ]),
      batchLabel: "UI batch",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.tasks).toHaveLength(1);
      expect(result.batchLabel).toBe("UI batch");
    }
  });

  it("returns a clear error for empty arrays", () => {
    const result = parseDispatchParallelTasks({ tasks: "[]" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("at least one");
  });

  it("detects truncated JSON arrays", () => {
    const truncated = '[{"agentId":"a","task":"x"},{"agentId":"b","task":"y"';
    const result = parseDispatchParallelTasks({ tasks: truncated });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.truncated).toBe(true);
      expect(result.error).toContain("truncated");
    }
  });

  it("salvages tasks and batchLabel from malformed markup text", () => {
    const text = `
_call name="dispatch_parallel">
Label>UI/UX ImprovementLabel>
[{"agentId":"frontend-specialist","task":"Hero.tsx","label":"Home"}]
    `;
    const result = parseDispatchParallelTasks({}, text);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.batchLabel).toBe("UI/UX Improvement");
      expect(result.tasks[0]!.agentId).toBe("frontend-specialist");
    }
  });
});

describe("extractJsonArray", () => {
  it("extracts a balanced array from nested JSON", () => {
    const json = '[{"a":1},{"b":[2,3]}]';
    expect(extractJsonArray(`prefix ${json} suffix`)?.json).toBe(json);
  });

  it("flags truncated arrays", () => {
    const r = extractJsonArray('[{"x":1}');
    expect(r?.truncated).toBe(true);
  });
});

describe("parseToolCalls dispatch_parallel salvage", () => {
  it("recovers dispatch_parallel from GLM-style malformed markup", () => {
    const text = `
Let me dispatch:
_call name="dispatch_parallel">
Label>Seven routesLabel>
[{"agentId":"frontend-specialist","task":"Scope A","label":"A"},{"agentId":"frontend-specialist","task":"Scope B","label":"B"}]
    `;
    const calls = parseToolCalls(text);
    expect(calls.some((c) => c.name === "dispatch_parallel")).toBe(true);
    const dp = calls.find((c) => c.name === "dispatch_parallel")!;
    const parsed = parseDispatchParallelTasks(dp.arguments);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.tasks).toHaveLength(2);
  });
});
