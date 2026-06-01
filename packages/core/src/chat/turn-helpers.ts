import { randomUUID } from "node:crypto";
import {
  loadAgencyConfig,
  resolveApiKey,
  estimateMessagesTokens,
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
import { EventBus } from "../events/event-bus.js";
import { emitThought } from "../events/cognition.js";
import { globalCostGovernor } from "../utils/governance-instance.js";
import { buildSystemPrompt } from "./prompt.js";
import type { ChatTurnInput, ChatMessage } from "./orchestrator.js";

/**
 * Chat-turn setup helpers shared by BOTH entry points — the non-streaming
 * `runChatTurn` (orchestrator.ts) and the streaming `runChatTurnWithStream`
 * (stream.ts). These three functions were previously copy-pasted, byte-for-byte,
 * into each file; a fix applied to one copy but not the other (e.g. a change to
 * route caching or key resolution) is exactly the divergence bug this module
 * removes. `ChatStreamInput extends ChatTurnInput`, so typing on the base input
 * serves both callers.
 */

/**
 * One stable session id per process, generated lazily so multiple turns in the
 * same CLI run share it while distinct invocations get distinct ids.
 */
let cliSessionFallback: string | undefined;

/**
 * Resolve the session id for a turn: explicit input → `AGENCY_SESSION_ID` env →
 * a unique-per-process fallback. The fallback was previously the constant
 * `"sess-cli"`, which made every headless `agency chat` run collide on one id —
 * and `loadHistoricalMemories` filters cross-session recall by
 * `session_id != current`, so a constant id meant the CLI agent could never
 * recall its own prior runs. A unique id per process fixes that recall while the
 * TUI (which always passes a real `session.id`) is unaffected.
 */
export function resolveSessionId(explicit?: string): string {
  if (explicit) return explicit;
  if (process.env.AGENCY_SESSION_ID) return process.env.AGENCY_SESSION_ID;
  if (!cliSessionFallback) cliSessionFallback = `sess-cli-${randomUUID()}`;
  return cliSessionFallback;
}

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
  // Narrate the planner decision to the cognition panel (no-op unless the
  // cognitionStream flag is on). Only on a fresh resolve — a cache hit is not a
  // new decision.
  emitThought({
    source: "planner",
    phase: "planning",
    severity: "info",
    confidence: "high",
    message: `Routing: ${route.intent} → ${route.provider}${route.suggested_agent ? ` · ${route.suggested_agent}` : ""}`,
  });
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

/**
 * Record a finished turn's token cost against the cost governor, falling back to
 * a ~chars/4 estimate (+200 prompt overhead) when the provider didn't report
 * usage. Shared by `runChatTurn` + `runChatTurnWithStream` so the estimate
 * formula lives in exactly one place — it was previously copy-pasted, identical,
 * into both turn paths.
 */
export function recordTurnTokenCost(
  usage: { promptTokens?: number; completionTokens?: number },
  contextPack: string,
  llmText: string,
  providerId: string
): void {
  const inputTokens = usage.promptTokens || Math.round(contextPack.length / 4) + 200;
  const outputTokens = usage.completionTokens || Math.round(llmText.length / 4);
  globalCostGovernor.recordTokens(inputTokens, outputTokens, providerId);
}

/** Minimal provider surface the compactor needs (matches LlmProvider.complete). */
interface CompletionProvider {
  complete(messages: ChatMessage[], opts?: { maxTokens?: number }): Promise<string>;
}

export interface CompactionOptions {
  /** Fraction of the context window above which compaction triggers (default 0.7). */
  thresholdRatio?: number;
  /** Most-recent turns kept verbatim, including the current user turn (default 4). */
  keepRecent?: number;
  /** Output cap for the generated summary (default 300). */
  maxSummaryTokens?: number;
}

export interface CompactionResult {
  messages: ChatMessage[];
  compacted: boolean;
  summarizedTurns: number;
}

/**
 * Roadmap §2.3 — proactively compress a turn's message list before it is sent
 * to the model, so a long conversation doesn't overflow the context window
 * mid-task. Keeps the leading system turn and the last `keepRecent` turns
 * verbatim and replaces the middle with a single model-written summary (or a
 * placeholder if the summary call fails or no provider is available).
 *
 * Returns the ORIGINAL array untouched (compacted=false) when below threshold or
 * too short, so a caller can stay byte-identical when the feature flag is off.
 * Never throws — compaction must not break a turn. Emits a best-effort
 * observability event when it triggers.
 */
export async function compactTurnHistory(
  messages: ChatMessage[],
  provider: CompletionProvider | null | undefined,
  contextWindowLimit: number,
  options: CompactionOptions = {}
): Promise<CompactionResult> {
  const thresholdRatio = options.thresholdRatio ?? 0.7;
  const keepRecent = options.keepRecent ?? 4;
  const maxSummaryTokens = options.maxSummaryTokens ?? 300;

  const threshold = Math.round(contextWindowLimit * thresholdRatio);
  const tokenCount = estimateMessagesTokens(messages);

  // Under budget, or too short to compress without dropping the system turn /
  // recent context → leave it exactly as-is.
  if (tokenCount <= threshold || messages.length <= keepRecent + 2) {
    return { messages, compacted: false, summarizedTurns: 0 };
  }

  const leadIsSystem = messages[0]?.role === "system";
  const head: ChatMessage[] = leadIsSystem ? [messages[0]!] : [];
  const startIndex = leadIsSystem ? 1 : 0;
  const recent = messages.slice(-keepRecent);
  const middle = messages.slice(startIndex, messages.length - keepRecent);

  if (middle.length === 0) {
    return { messages, compacted: false, summarizedTurns: 0 };
  }

  let summaryText = "";
  if (provider && typeof provider.complete === "function") {
    try {
      const payload =
        "Summarize the following developer interaction history cleanly and very " +
        "briefly, preserving key findings, active tasks, decisions, and any " +
        "acceptance criteria. Output only the summary:\n\n" +
        middle.map((m) => `[${m.role}]: ${m.content}`).join("\n");
      const out = await provider.complete([{ role: "user", content: payload }], {
        maxTokens: maxSummaryTokens,
      });
      summaryText = typeof out === "string" ? out.trim() : "";
    } catch {
      // Compaction must never break a turn — fall through to the placeholder.
    }
  }

  if (!summaryText) {
    summaryText = `[${middle.length} earlier turn(s) omitted to fit the context window]`;
  }

  const summaryTurn: ChatMessage = {
    role: "system",
    content: `[CONVERSATION SUMMARY]: ${summaryText}`,
  };

  try {
    void EventBus.getInstance().publish("system:warning", {
      message: `⚠ Context compaction: summarized ${middle.length} older turn(s) (~${tokenCount} est tokens > ${threshold} threshold) to fit the model window.`,
    });
  } catch {
    /* observability is best-effort */
  }

  // Narrate the context adaptation to the cognition panel (no-op unless the
  // cognitionStream flag is on). Separate channel from the system:warning above.
  emitThought({
    source: "retrieval",
    phase: "retrieval",
    severity: "adaptation",
    confidence: "high",
    message: `Context compaction: summarized ${middle.length} older turn(s) (~${tokenCount} est tokens) to fit the model window.`,
  });

  return {
    messages: [...head, summaryTurn, ...recent],
    compacted: true,
    summarizedTurns: middle.length,
  };
}
