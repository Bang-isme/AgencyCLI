import { CostGovernor } from "@agency/governance";
import { BenchmarkResult, CategoryStat, EvalReport } from "./types.js";

/** Estimate USD cost from token counts (pure; wraps the cost governor's rates). */
export function estimateTokenCost(promptTokens: number, completionTokens: number, modelId: string): number {
  return new CostGovernor().estimateCost(promptTokens, completionTokens, modelId);
}

function avg(nums: number[]): number {
  if (nums.length === 0) return 0;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

/**
 * Aggregates per-task results into the headline measurement: **task success
 * rate** (not "tests pass"), plus average cost / time / rounds and the
 * manual-intervention rate. This is the object the regression gate compares.
 */
export function aggregateResults(results: BenchmarkResult[]): EvalReport {
  const total = results.length;
  const passed = results.filter((r) => r.success).length;
  const interventions = results.filter((r) => r.intervened).length;

  const byCategory: Record<string, CategoryStat> = {};
  for (const r of results) {
    const key = r.category ?? "uncategorized";
    const stat = byCategory[key] ?? { total: 0, passed: 0, successRate: 0 };
    stat.total += 1;
    if (r.success) stat.passed += 1;
    byCategory[key] = stat;
  }
  for (const stat of Object.values(byCategory)) {
    stat.successRate = stat.total > 0 ? stat.passed / stat.total : 0;
  }

  return {
    total,
    passed,
    successRate: total > 0 ? passed / total : 0,
    avgDurationMs: avg(results.map((r) => r.durationMs)),
    avgCostUsd: avg(results.map((r) => r.costUsd)),
    avgRounds: avg(results.map((r) => r.rounds)),
    interventionRate: total > 0 ? interventions / total : 0,
    byCategory,
    results,
  };
}

/** One-line human summary of a report. */
export function formatEvalReport(report: EvalReport): string {
  const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
  return [
    `success ${report.passed}/${report.total} (${pct(report.successRate)})`,
    `avg ${(report.avgDurationMs / 1000).toFixed(1)}s`,
    `avg $${report.avgCostUsd.toFixed(4)}`,
    `avg ${report.avgRounds.toFixed(1)} rounds`,
    `intervention ${pct(report.interventionRate)}`,
  ].join(" · ");
}
