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
  return /^Exit Code:\s*[1-9]/.test(result);
}
