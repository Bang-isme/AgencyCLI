import type { RouteResult } from "../router/model-router.js";
import { getInvokeActions } from "../skill/invoke-actions.js";

/**
 * Canonical home for the pure "route → display strings" presentation helpers
 * (`formatRouteSummary`, `buildSuggestedCommands`).
 *
 * These were previously defined in `chat/orchestrator.ts`, but other layers need
 * them — `context/pack.ts` uses `formatRouteSummary`, and `agents/orchestrator.ts`
 * uses `buildSuggestedCommands`. Those imports made the *context* and *agents/
 * skill* layers reach back into the chat orchestrator, forming two runtime import
 * cycles into `chat/orchestrator.ts`:
 *   - orchestrator → turn-helpers → context/pack → orchestrator
 *   - orchestrator → turn-helpers → chat/prompt → skill/tool-harness →
 *     agents/orchestrator → orchestrator
 * Besides being a layering violation, the cycle split module identity under test
 * mocking: a partial mock of `turn-helpers` whose factory calls `importOriginal()`
 * pulled the real `orchestrator` back in through the cycle, so the orchestrator
 * bound the *real* helpers instead of the test's spies.
 *
 * Pulling these pure helpers into a leaf module breaks both edges: it only
 * depends on the `RouteResult` type (erased at runtime) and `getInvokeActions`
 * (itself a leaf), so nothing here reaches back into `chat/orchestrator.ts`.
 * `orchestrator.ts` re-exports both so existing `from "./orchestrator.js"`
 * consumers keep one import path.
 */
export function formatRouteSummary(route: RouteResult): string {
  const parts = [
    `intent: ${route.intent}`,
    `workflow: ${route.workflow}`,
    `provider: ${route.provider}`,
  ];
  if (route.suggested_agent) {
    parts.push(`agent: ${route.suggested_agent}`);
  }
  if (route.skills.length > 0) {
    parts.push(`skills: ${route.skills.join(", ")}`);
  }
  if (route.warnings.length > 0) {
    parts.push(`warnings: ${route.warnings.join("; ")}`);
  }
  return parts.join(" · ");
}

export function buildSuggestedCommands(
  route: RouteResult,
  projectRoot: string,
  prompt: string
): string[] {
  const seen = new Set<string>();
  const commands: string[] = [];
  const add = (cmd: string) => {
    if (!seen.has(cmd)) {
      seen.add(cmd);
      commands.push(cmd);
    }
  };

  add(`agency workflow run ${route.workflow} --project-root .`);
  if (route.suggested_agent) {
    const escaped = prompt.replace(/"/g, '\\"');
    add(
      `agency agents dispatch ${route.suggested_agent} --task "${escaped}"`
    );
  }
  for (const skill of route.skills) {
    for (const action of getInvokeActions(skill, projectRoot)) {
      add(action);
    }
  }
  const trimmed = prompt.trim();
  if (route.skills.length === 0 && trimmed.length > 0) {
    add(`agency route "${trimmed.replace(/"/g, '\\"')}"`);
  }
  return commands;
}
