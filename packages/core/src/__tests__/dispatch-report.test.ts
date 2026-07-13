import { describe, expect, it } from "vitest";
import {
  buildParallelDispatchReport,
  formatReportForModel,
} from "../agents/dispatch-report.js";
import type { ParallelDispatchResult } from "../agents/orchestrator.js";

describe("dispatch-report", () => {
  it("aggregates parallel fan-out into a structured report", () => {
    const fanout: ParallelDispatchResult = {
      success: false,
      results: [
        {
          agentId: "frontend-specialist",
          dispatchId: "d-1",
          exitCode: 0,
          stdout: "Updated Footer.tsx",
          stderr: "",
          isolatedEnv: {},
          payload: { filesWritten: ["src/Footer.tsx"] },
        },
        {
          agentId: "frontend-specialist",
          dispatchId: "d-2",
          exitCode: 1,
          stdout: "",
          stderr: "Build failed",
          isolatedEnv: {},
        },
      ],
      mergeResult: { success: true, conflicts: [] },
    };

    const report = buildParallelDispatchReport(fanout, {
      batchId: "batch-test",
      batchLabel: "Footer refactor",
      labels: new Map([
        ["d-1", "Footer layout"],
        ["d-2", "Footer tests"],
      ]),
      taskByDispatchId: new Map([
        ["d-1", "Fix footer layout"],
        ["d-2", "Add footer tests"],
      ]),
    });

    expect(report.total).toBe(2);
    expect(report.succeeded).toBe(1);
    expect(report.failed).toBe(1);
    expect(report.batchLabel).toBe("Footer refactor");
    expect(report.tasks[0]!.label).toBe("Footer layout");
    expect(report.tasks[1]!.status).toBe("failed");

    const modelText = formatReportForModel(report);
    expect(modelText).toContain("PARALLEL DISPATCH REPORT");
    expect(modelText).toContain("Footer layout");
    expect(modelText).toContain("Build failed");
  });
});
