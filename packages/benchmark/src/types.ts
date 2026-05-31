export type TaskCategory = "bugfix" | "feature" | "test" | "refactor" | "analysis";

/** Context handed to a task's execute step (the actual agent attempt). */
export interface ExecuteContext {
  projectRoot: string;
  objective: string;
  budgetLimit: number;
}

/** What an execute step reports back about the attempt (all optional). */
export interface ExecuteOutcome {
  /** Number of agent loop iterations / turns the attempt took. */
  rounds?: number;
  /** Estimated USD cost of the attempt. */
  costUsd?: number;
  /** True if the attempt required a human/manual intervention to proceed. */
  intervened?: boolean;
}

export interface BenchmarkTask {
  id: string;
  name: string;
  objective: string;
  category?: TaskCategory;
  /** Prepare the (usually broken/incomplete) starting state. */
  setup?: (projectRoot: string) => Promise<void>;
  /**
   * Actually attempt the objective. Real eval wires this to the agent runtime;
   * tests inject a deterministic mock. Omit for a pure validation smoke task.
   */
  execute?: (ctx: ExecuteContext) => Promise<ExecuteOutcome | void>;
  /** Acceptance check — measures the OUTCOME, not just "tests pass". */
  validate: (projectRoot: string) => Promise<{ success: boolean; error?: string }>;
  cleanup?: (projectRoot: string) => Promise<void>;
}

export interface BenchmarkResult {
  taskId: string;
  category?: TaskCategory;
  success: boolean;
  durationMs: number;
  costUsd: number;
  /** Agent loop iterations the attempt took (0 when no execute step). */
  rounds: number;
  /** Whether the attempt needed a manual intervention. */
  intervened: boolean;
  error?: string;
}

export interface CategoryStat {
  total: number;
  passed: number;
  successRate: number;
}

/** Aggregate measurement across a suite run — the thing we gate on. */
export interface EvalReport {
  total: number;
  passed: number;
  /** Fraction in [0,1]. The headline metric — "task success rate", not "tests pass". */
  successRate: number;
  avgDurationMs: number;
  avgCostUsd: number;
  avgRounds: number;
  /** Fraction of tasks that needed a manual intervention, in [0,1]. */
  interventionRate: number;
  byCategory: Record<string, CategoryStat>;
  results: BenchmarkResult[];
}
