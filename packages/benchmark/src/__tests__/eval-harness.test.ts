import { describe, expect, it, afterEach } from "vitest";
import { promises as fs, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  runBenchmarkTask,
  aggregateResults,
  gateAgainstBaseline,
  loadBaseline,
  saveBaseline,
  scriptCompilationTask,
  type BenchmarkTask,
  type BenchmarkResult,
} from "../index.js";

const tempDirs: string[] = [];
afterEach(() => {
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
  tempDirs.length = 0;
});
function tempRoot(): string {
  const d = mkdtempSync(join(tmpdir(), "agency-eval-"));
  tempDirs.push(d);
  return d;
}

function result(over: Partial<BenchmarkResult> & { taskId: string; success: boolean }): BenchmarkResult {
  return { durationMs: 0, costUsd: 0, rounds: 0, intervened: false, ...over };
}

describe("eval harness — execute step", () => {
  it("runs setup → execute → validate and records cost/rounds/intervention", async () => {
    const task: BenchmarkTask = {
      id: "fixme",
      name: "fix flag",
      objective: "set the flag to fixed",
      category: "bugfix",
      setup: async (root) => fs.writeFile(join(root, "flag.txt"), "broken"),
      execute: async (ctx) => {
        // Simulates the agent fixing the broken state.
        await fs.writeFile(join(ctx.projectRoot, "flag.txt"), "fixed");
        return { rounds: 3, costUsd: 0.012, intervened: false };
      },
      validate: async (root) => {
        const v = await fs.readFile(join(root, "flag.txt"), "utf8");
        return { success: v === "fixed", error: v === "fixed" ? undefined : "still broken" };
      },
    };

    const res = await runBenchmarkTask(task, tempRoot());
    expect(res.success).toBe(true);
    expect(res.rounds).toBe(3);
    expect(res.costUsd).toBeCloseTo(0.012);
    expect(res.intervened).toBe(false);
    expect(res.category).toBe("bugfix");
  });

  it("reports failure when the execute step does not satisfy acceptance", async () => {
    const task: BenchmarkTask = {
      id: "noop",
      name: "noop",
      objective: "set the flag to fixed",
      setup: async (root) => fs.writeFile(join(root, "flag.txt"), "broken"),
      execute: async () => ({ rounds: 1 }), // agent does nothing useful
      validate: async (root) => {
        const v = await fs.readFile(join(root, "flag.txt"), "utf8");
        return { success: v === "fixed", error: "still broken" };
      },
    };

    const res = await runBenchmarkTask(task, tempRoot());
    expect(res.success).toBe(false);
    expect(res.error).toBe("still broken");
    expect(res.rounds).toBe(1);
  });

  it("script-compilation validates hermetically (resolves real tsc, not `npx tsc`)", async () => {
    // Regression guard: the isolated workspace excludes node_modules, so `npx tsc`
    // used to fall through to the deprecated `tsc` squatter package and fail in any
    // clean environment. The task must resolve the real compiler from our dep tree.
    const res = await runBenchmarkTask(scriptCompilationTask, tempRoot());
    expect(res.success).toBe(true);
    expect(res.error).toBeUndefined();
  });
});

describe("aggregateResults", () => {
  it("computes success rate, averages, intervention rate and per-category stats", () => {
    const report = aggregateResults([
      result({ taskId: "a", category: "bugfix", success: true, durationMs: 100, costUsd: 0.02, rounds: 2 }),
      result({ taskId: "b", category: "bugfix", success: false, durationMs: 300, costUsd: 0.04, rounds: 6, intervened: true }),
      result({ taskId: "c", category: "feature", success: true, durationMs: 200, costUsd: 0.06, rounds: 4 }),
    ]);

    expect(report.total).toBe(3);
    expect(report.passed).toBe(2);
    expect(report.successRate).toBeCloseTo(2 / 3);
    expect(report.avgDurationMs).toBeCloseTo(200);
    expect(report.avgCostUsd).toBeCloseTo(0.04);
    expect(report.avgRounds).toBeCloseTo(4);
    expect(report.interventionRate).toBeCloseTo(1 / 3);
    expect(report.byCategory.bugfix).toEqual({ total: 2, passed: 1, successRate: 0.5 });
    expect(report.byCategory.feature).toEqual({ total: 1, passed: 1, successRate: 1 });
  });
});

describe("gateAgainstBaseline (regression gate)", () => {
  const baseline = aggregateResults([
    result({ taskId: "a", success: true }),
    result({ taskId: "b", success: true }),
  ]);

  it("passes when success rate holds", () => {
    const current = aggregateResults([
      result({ taskId: "a", success: true }),
      result({ taskId: "b", success: true }),
    ]);
    const gate = gateAgainstBaseline(current, baseline);
    expect(gate.passed).toBe(true);
    expect(gate.delta).toBe(0);
    expect(gate.regressedTasks).toEqual([]);
  });

  it("fails when a previously-passing task regresses", () => {
    const current = aggregateResults([
      result({ taskId: "a", success: false }),
      result({ taskId: "b", success: true }),
    ]);
    const gate = gateAgainstBaseline(current, baseline);
    expect(gate.passed).toBe(false);
    expect(gate.currentSuccessRate).toBeCloseTo(0.5);
    expect(gate.regressedTasks).toEqual(["a"]);
  });

  it("respects the success-rate tolerance when task-regression check is off", () => {
    const current = aggregateResults([
      result({ taskId: "a", success: false }),
      result({ taskId: "b", success: true }),
    ]);
    const gate = gateAgainstBaseline(current, baseline, {
      successRateTolerance: 0.5,
      failOnTaskRegression: false,
    });
    expect(gate.passed).toBe(true);
  });

  it("round-trips a baseline to disk", async () => {
    const path = join(tempRoot(), "nested", "baseline.json");
    await saveBaseline(path, baseline);
    const loaded = await loadBaseline(path);
    expect(loaded?.successRate).toBe(baseline.successRate);
    expect(loaded?.results.length).toBe(2);
    expect(await loadBaseline(join(tempRoot(), "missing.json"))).toBeNull();
  });
});
