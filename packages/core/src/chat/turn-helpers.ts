import {
  loadAgencyConfig,
  resolveApiKey,
  type ProviderId,
} from "@agency/providers";
import {
  buildAtReferenceContext,
  resolveAllFileReferences,
} from "../context/file-refs.js";
import { buildContextPack } from "../context/pack.js";
import { getCachedRoute, setCachedRoute } from "../context/session-cache.js";
import { type TokenBudgetPlan } from "../context/token-policy.js";
import { routeUserPrompt, type RouteResult } from "../router/model-router.js";
import { buildSystemPrompt } from "./prompt.js";
import type { ChatTurnInput } from "./orchestrator.js";

/**
 * Chat-turn setup helpers shared by BOTH entry points — the non-streaming
 * `runChatTurn` (orchestrator.ts) and the streaming `runChatTurnWithStream`
 * (stream.ts). These three functions were previously copy-pasted, byte-for-byte,
 * into each file; a fix applied to one copy but not the other (e.g. a change to
 * route caching or key resolution) is exactly the divergence bug this module
 * removes. `ChatStreamInput extends ChatTurnInput`, so typing on the base input
 * serves both callers.
 */

/** Resolve the route for a turn, honouring the per-plan route cache. */
export async function resolveRoute(
  input: ChatTurnInput,
  plan: TokenBudgetPlan
): Promise<{ route: RouteResult; fromCache: boolean }> {
  if (plan.useRouteCache) {
    const cached = getCachedRoute(input.projectRoot, input.prompt);
    if (cached) return { route: cached, fromCache: true };
  }
  const route = await routeUserPrompt(
    input.skillsRoot,
    input.prompt,
    input.projectRoot
  );
  if (plan.useRouteCache) {
    setCachedRoute(input.projectRoot, input.prompt, route);
  }
  return { route, fromCache: false };
}

/** True when the provider has a usable API key (`local` needs none). */
export function providerHasKey(
  providerId: ProviderId,
  config: ReturnType<typeof loadAgencyConfig>
): boolean {
  if (providerId === "local") return true;
  const profile = config.providers[providerId] ?? {};
  return Boolean(resolveApiKey(profile)?.trim());
}

/** Rebuild the context pack + system prompt (used on a context-limit retry). */
export function repackContextAndSystemPrompt(
  input: ChatTurnInput,
  route: RouteResult,
  plan: TokenBudgetPlan,
  historicalMemories?: string
): string {
  const atRefs = resolveAllFileReferences(input.prompt, input.projectRoot);
  const atBlock =
    atRefs.length > 0
      ? buildAtReferenceContext(input.projectRoot, atRefs, plan.maxContextChars)
          .block
      : "";
  const basePack = buildContextPack(input.projectRoot, route, plan);
  const contextPack = atBlock
    ? `${basePack}\n\n${atBlock}`.slice(0, plan.maxContextChars)
    : basePack;
  return buildSystemPrompt(
    route,
    input.prompt,
    contextPack,
    input.projectRoot,
    input.history,
    input.systemInstructionOverride,
    historicalMemories
  );
}
