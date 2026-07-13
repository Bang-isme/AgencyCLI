/**
 * Canonical predicates for classifying a tool RESULT string as a failure.
 *
 * Single source of truth shared by the circuit breaker (tool-harness.ts, which
 * composes them WITH the `breakerFailedExits` flag) and the tool-lifecycle
 * events (tool-events.ts, which compose them WITHOUT the flag for display truth).
 * Kept as a zero-dependency leaf so neither caller introduces an import cycle.
 *
 * Convention: tool handlers return an `Error…` string on failure; command/
 * dispatch tools return `Exit Code: <n>` where a non-zero `n` is a failure.
 */

/** A handler-failure / hard-refusal result (the `Error…` convention). */
export function isErrorResult(result: string): boolean {
  return /^Error[:\s]/.test(result);
}

/** A command/dispatch result whose reported exit code is non-zero. */
export function isNonZeroExitResult(result: string): boolean {
  const match = /^Exit Code:\s*(-?\d+)/.exec(result);
  return match ? Number.parseInt(match[1]!, 10) !== 0 : false;
}

/** Grep/search tools that succeeded with zero matches — not a failure. */
export function isBenignEmptyResult(result: string): boolean {
  return (
    /^No matches found\b/i.test(result) ||
    /^No files found\b/i.test(result) ||
    /^Found 0 match/i.test(result)
  );
}

/** Whether a tool result should count as failure for the circuit breaker. */
export function toolResultCountsAsFailure(result: string): boolean {
  if (isBenignEmptyResult(result)) return false;
  return isErrorResult(result) || isNonZeroExitResult(result);
}
