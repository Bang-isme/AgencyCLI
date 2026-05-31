import { promises as fs } from "node:fs";
import { dirname } from "node:path";
import { EvalReport } from "./types.js";

export interface GateOptions {
  /**
   * How far the overall success rate may drop (absolute fraction) before the
   * gate fails. Default 0 = no regression allowed.
   */
  successRateTolerance?: number;
  /**
   * Fail if any task that passed in the baseline now fails, even if the overall
   * rate is within tolerance. Default true — catches "swapped a pass for a pass
   * elsewhere" masking.
   */
  failOnTaskRegression?: boolean;
}

export interface GateResult {
  passed: boolean;
  baselineSuccessRate: number;
  currentSuccessRate: number;
  /** current − baseline (positive = improvement). */
  delta: number;
  /** Task ids that passed in the baseline but fail now. */
  regressedTasks: string[];
  reason: string;
}

/**
 * Regression gate: a change must not lower task success rate. Compares a fresh
 * {@link EvalReport} against a saved baseline and decides pass/fail. This is
 * what turns "I think it's better" into "it's not worse" — run it in CI with a
 * committed baseline.
 */
export function gateAgainstBaseline(
  current: EvalReport,
  baseline: EvalReport,
  opts: GateOptions = {}
): GateResult {
  const tolerance = opts.successRateTolerance ?? 0;
  const failOnTaskRegression = opts.failOnTaskRegression ?? true;

  const delta = current.successRate - baseline.successRate;

  const baselinePass = new Map(baseline.results.map((r) => [r.taskId, r.success]));
  const regressedTasks = current.results
    .filter((r) => baselinePass.get(r.taskId) === true && !r.success)
    .map((r) => r.taskId);

  const rateOk = current.successRate >= baseline.successRate - tolerance;
  const taskOk = !failOnTaskRegression || regressedTasks.length === 0;
  const passed = rateOk && taskOk;

  let reason: string;
  if (passed) {
    reason = delta >= 0 ? `success rate held or improved (+${(delta * 100).toFixed(1)}%)` : `within tolerance (${(delta * 100).toFixed(1)}%)`;
  } else if (!rateOk) {
    reason = `success rate dropped ${(delta * 100).toFixed(1)}% (tolerance ${(tolerance * 100).toFixed(1)}%)`;
  } else {
    reason = `${regressedTasks.length} task(s) regressed: ${regressedTasks.join(", ")}`;
  }

  return {
    passed,
    baselineSuccessRate: baseline.successRate,
    currentSuccessRate: current.successRate,
    delta,
    regressedTasks,
    reason,
  };
}

export async function loadBaseline(path: string): Promise<EvalReport | null> {
  try {
    return JSON.parse(await fs.readFile(path, "utf8")) as EvalReport;
  } catch {
    return null;
  }
}

export async function saveBaseline(path: string, report: EvalReport): Promise<void> {
  await fs.mkdir(dirname(path), { recursive: true });
  await fs.writeFile(path, JSON.stringify(report, null, 2), "utf8");
}
