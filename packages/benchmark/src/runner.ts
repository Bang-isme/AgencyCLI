import { createIsolatedWorkspace, cleanIsolatedWorkspace } from "@agency/core";
import { BenchmarkTask, BenchmarkResult } from "./types.js";

/**
 * Runs a single benchmark task end-to-end in an isolated workspace:
 *   setup → execute (the agent attempt) → validate (acceptance) → cleanup.
 *
 * The cost/rounds/intervention come from the execute step, so the result
 * reflects what the *agent* actually did — not just whether a pre-baked state
 * validates. Tasks without an execute step are pure validation smoke checks.
 */
export async function runBenchmarkTask(
  task: BenchmarkTask,
  projectRoot: string,
  budgetLimit = 5.0
): Promise<BenchmarkResult> {
  const ws = createIsolatedWorkspace(projectRoot, `benchmark-${task.id}`);
  const startTime = Date.now();

  let success = false;
  let errorMsg: string | undefined;
  let costUsd = 0;
  let rounds = 0;
  let intervened = false;

  try {
    if (task.setup) {
      await task.setup(ws.tempDir);
    }

    if (task.execute) {
      const outcome = await task.execute({
        projectRoot: ws.tempDir,
        objective: task.objective,
        budgetLimit,
      });
      if (outcome) {
        costUsd = outcome.costUsd ?? 0;
        rounds = outcome.rounds ?? 0;
        intervened = outcome.intervened ?? false;
      }
    }

    const validation = await task.validate(ws.tempDir);
    success = validation.success;
    errorMsg = validation.error;

    if (task.cleanup) {
      await task.cleanup(ws.tempDir);
    }
  } catch (err: any) {
    success = false;
    errorMsg = err?.message || String(err);
  } finally {
    try {
      cleanIsolatedWorkspace(ws);
    } catch (cleanErr) {
      console.error(`Failed to clean workspace for task ${task.id}:`, cleanErr);
    }
  }

  return {
    taskId: task.id,
    category: task.category,
    success,
    durationMs: Date.now() - startTime,
    costUsd,
    rounds,
    intervened,
    error: errorMsg,
  };
}

export async function runBenchmarkSuite(
  tasks: BenchmarkTask[],
  projectRoot: string,
  budgetLimit = 5.0
): Promise<BenchmarkResult[]> {
  const results: BenchmarkResult[] = [];
  for (const task of tasks) {
    results.push(await runBenchmarkTask(task, projectRoot, budgetLimit));
  }
  return results;
}
