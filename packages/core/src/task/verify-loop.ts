/**
 * Outer verify loop — the "soul" of a real harness (maturity tier 4).
 *
 * A single LLM turn that "builds" is not the same as a task done correctly. This
 * loop runs: attempt → verify against acceptance criteria → (if failed) feed the
 * failure back and retry → until it passes, runs out of rounds/budget, or stops
 * making progress. It turns "guess once" into "self-correct until acceptance".
 *
 * Pure orchestration: the caller injects `attempt` (do the work, optionally
 * using the previous round's failures) and `verify` (run the acceptance check).
 * That keeps it fully unit-testable without an LLM, and reusable from
 * dispatchAgent / runPlan.
 */

export interface VerifyResult {
  passed: boolean;
  /** Human-readable failure summary fed back into the next attempt. */
  failures: string;
  /**
   * Stable signature of the failure, used for no-progress detection. Defaults
   * to `failures` when omitted. Normalise volatile bits (paths, timestamps) for
   * best results so an identical failure is recognised as "stuck".
   */
  signature?: string;
}

export interface AttemptContext {
  /** 1-based round number. */
  round: number;
  /** Acceptance failures from the previous round (undefined on round 1). */
  previousFailures?: string;
}

export type VerifyLoopStopReason =
  | "passed"
  | "max-rounds"
  | "no-progress"
  | "budget-exhausted";

export interface VerifyLoopOptions {
  /** Hard ceiling on attempts (default 3, floored at 1). 1 = single attempt (legacy). */
  maxRounds?: number;
  /**
   * Stop early if the same failure signature recurs this many rounds in a row
   * (default 2). Prevents burning budget on a stuck loop.
   */
  noProgressLimit?: number;
  /** Optional pre-round budget check: return false to stop before the next attempt. */
  hasBudget?: () => boolean;
}

export interface VerifyLoopResult {
  success: boolean;
  rounds: number;
  stopReason: VerifyLoopStopReason;
  history: Array<{ round: number; verify: VerifyResult }>;
}

export async function runVerifyLoop(
  attempt: (ctx: AttemptContext) => Promise<void>,
  verify: () => Promise<VerifyResult>,
  opts: VerifyLoopOptions = {}
): Promise<VerifyLoopResult> {
  const maxRounds = Math.max(1, Math.floor(opts.maxRounds ?? 3));
  const noProgressLimit = Math.max(1, Math.floor(opts.noProgressLimit ?? 2));
  const history: Array<{ round: number; verify: VerifyResult }> = [];

  let previousFailures: string | undefined;
  let lastSignature: string | undefined;
  let sameCount = 0;

  for (let round = 1; round <= maxRounds; round++) {
    if (opts.hasBudget && !opts.hasBudget()) {
      return { success: false, rounds: round - 1, stopReason: "budget-exhausted", history };
    }

    await attempt({ round, previousFailures });
    const result = await verify();
    history.push({ round, verify: result });

    if (result.passed) {
      return { success: true, rounds: round, stopReason: "passed", history };
    }

    previousFailures = result.failures;

    // No-progress detection: an identical failure recurring means the agent is
    // stuck — stop instead of re-spending budget on the same dead end.
    const sig = result.signature ?? result.failures;
    if (sig === lastSignature) {
      sameCount += 1;
    } else {
      sameCount = 1;
      lastSignature = sig;
    }
    if (sameCount >= noProgressLimit && round < maxRounds) {
      return { success: false, rounds: round, stopReason: "no-progress", history };
    }
  }

  return { success: false, rounds: maxRounds, stopReason: "max-rounds", history };
}
