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
  /**
   * Max characters fed to a single summarization call (default 8000 ≈ 2k
   * tokens). When the middle exceeds this it is summarized in chunks and the
   * partial summaries are combined, so the summarizer prompt itself can never
   * overflow the model window (the old single-shot summary of an unbounded
   * middle could).
   */
  maxInputChars?: number;
  /**
   * Scope for the cross-turn running summary (typically the session id). When
   * set, a later turn whose middle *extends* an already-summarized one only
   * summarizes the NEW turns (folding them into the prior summary) instead of
   * re-summarizing the whole middle every turn — O(new) not O(all). Absent ⇒ no
   * caching (each call summarizes from scratch), which keeps callers that don't
   * opt in byte-identical.
   */
  cacheKey?: string;
}

/**
 * Per-scope running-summary memo: the most-recently summarized middle for a
 * cacheKey and the summary it produced. Lets a growing conversation summarize
 * incrementally instead of re-summarizing the whole middle each turn.
 */
const runningSummaryCache = new Map<string, { coveredCount: number; coveredContent: string; summary: string }>();

/** Render a turn list as the summarizer's plain-text input. */
function renderForSummary(messages: ChatMessage[]): string {
  return messages.map((m) => `[${m.role}]: ${m.content}`).join("\n");
}

const SUMMARY_INSTRUCTION =
  "Summarize the following developer interaction history cleanly and very " +
  "briefly, preserving key findings, active tasks, decisions, and any " +
  "acceptance criteria. Output only the summary:\n\n";

/**
 * Summarize the middle turns without ever overflowing the summarizer's own
 * context: if the rendered middle fits in `maxInputChars` it is one call,
 * otherwise it is chunked (each chunk ≤ budget) and the partial summaries are
 * combined hierarchically (also bounded). Returns "" on any failure so the
 * caller falls back to a placeholder. Never throws.
 */
async function summarizeMiddle(
  middle: ChatMessage[],
  provider: CompletionProvider,
  maxSummaryTokens: number,
  maxInputChars: number
): Promise<string> {
  const once = async (text: string): Promise<string> => {
    const out = await provider.complete([{ role: "user", content: SUMMARY_INSTRUCTION + text }], {
      maxTokens: maxSummaryTokens,
    });
    return typeof out === "string" ? out.trim() : "";
  };

  try {
    const full = renderForSummary(middle);
    if (full.length <= maxInputChars) {
      return await once(full);
    }

    // Pack messages into chunks that each fit the input budget.
    const chunks: string[] = [];
    let buf: ChatMessage[] = [];
    let bufLen = 0;
    for (const m of middle) {
      const piece = `[${m.role}]: ${m.content}`;
      if (bufLen > 0 && bufLen + piece.length > maxInputChars) {
        chunks.push(renderForSummary(buf));
        buf = [];
        bufLen = 0;
      }
      buf.push(m);
      bufLen += piece.length + 1;
    }
    if (buf.length > 0) chunks.push(renderForSummary(buf));

    const partials: string[] = [];
    for (const c of chunks) {
      const s = await once(c.slice(0, maxInputChars));
      if (s) partials.push(s);
    }
    if (partials.length === 0) return "";
    if (partials.length === 1) return partials[0]!;

    // Combine partial summaries (bounded — fall back to the concatenation if the
    // combine call exceeds budget or fails).
    const combined = partials.join("\n");
    if (combined.length > maxInputChars) return combined.slice(0, maxInputChars);
    return (await once(combined)) || combined;
  } catch {
    // Compaction must never break a turn — caller substitutes a placeholder.
    return "";
  }
}

export interface CompactionResult {
  messages: ChatMessage[];
  compacted: boolean;
  summarizedTurns: number;
}

/**
 * Summarize the middle, reusing a prior summary when this middle merely extends
 * an already-summarized one (the common case for a growing conversation): only
 * the NEW turns are summarized, folded into the cached summary, rather than
 * re-summarizing every older turn each turn. Falls back to a full summary when
 * there is no usable cache entry. Caching is per `cacheKey`; with none it always
 * summarizes the full middle (byte-identical to the non-cached path).
 */
async function computeMiddleSummary(
  middle: ChatMessage[],
  provider: CompletionProvider,
  maxSummaryTokens: number,
  maxInputChars: number,
  cacheKey?: string
): Promise<string> {
  let summary = "";

  const cached = cacheKey ? runningSummaryCache.get(cacheKey) : undefined;
  if (
    cached &&
    middle.length >= cached.coveredCount &&
    renderForSummary(middle.slice(0, cached.coveredCount)) === cached.coveredContent
  ) {
    if (middle.length === cached.coveredCount) {
      // Identical middle as last time → reuse the summary, no LLM call.
      return cached.summary;
    }
    // Incremental: summarize only the appended turns on top of the prior summary.
    const newTail = middle.slice(cached.coveredCount);
    summary = await summarizeMiddle(
      [{ role: "system", content: `Summary of the earlier conversation so far: ${cached.summary}` }, ...newTail],
      provider,
      maxSummaryTokens,
      maxInputChars
    );
  } else {
    summary = await summarizeMiddle(middle, provider, maxSummaryTokens, maxInputChars);
  }

  if (cacheKey && summary) {
    runningSummaryCache.set(cacheKey, {
      coveredCount: middle.length,
      coveredContent: renderForSummary(middle),
      summary,
    });
  }
  return summary;
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
  const maxInputChars = options.maxInputChars ?? 8000;

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
    // Chunked + bounded (the summarizer's own prompt can never overflow), and
    // incremental across turns when a cacheKey is supplied.
    summaryText = await computeMiddleSummary(middle, provider, maxSummaryTokens, maxInputChars, options.cacheKey);
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

/** Context the reactive reducer needs to rebuild the system prompt + summarize. */
export interface ReduceHistoryContext {
  input: ChatTurnInput;
  route: RouteResult;
  /** The reduced budget plan (already recomputed at the lowered window). */
  plan: TokenBudgetPlan;
  historicalMemories?: string;
  /** Provider used to summarize the middle (same one the turn uses). */
  provider?: CompletionProvider | null;
  /** Session id → makes the in-reducer compaction incremental across retries. */
  cacheKey?: string;
  /**
   * Fraction of `newLimit` the reduced history must fit under, leaving headroom
   * for the completion + estimator slop (default 0.8).
   */
  safety?: number;
}

export interface ReduceHistoryResult {
  messages: ChatMessage[];
  estimatedTokens: number;
  /** True once the estimate is within `newLimit * safety`. */
  fits: boolean;
}

/**
 * Roadmap §8.1 — the reactive last-resort reducer shared by BOTH turn paths
 * (`runChatTurn` and `runChatTurnWithStream`). When a provider rejects a turn
 * for exceeding its context window, the old handler only repacked the SYSTEM
 * prompt (`turnHistory[0]`) and retried — but the overflow lives in the
 * conversation BODY (accumulated tool results, file reads, long pastes), so the
 * retry re-sent an oversized history and failed again until `maxAttempts`, then
 * threw. This is the crash the user hit ("auto-reducing" logged but never
 * effective).
 *
 * It reduces the body for real, in three stages, until the (conservative,
 * err-high) estimate fits `newLimit * safety`:
 *  1. repack the system prompt at the reduced plan (the legacy behaviour);
 *  2. summarize the middle via the canonical {@link compactTurnHistory} (forced
 *     past its threshold since we're already over budget);
 *  3. if still over, trim the largest middle message bodies, then drop the
 *     oldest middle turns — never touching the system turn or the final
 *     (current) message.
 *
 * Never throws. Returns the reduced history and whether it actually fits, so the
 * caller can assert before retrying.
 */
export async function reduceHistoryToFit(
  turnHistory: ChatMessage[],
  newLimit: number,
  ctx: ReduceHistoryContext
): Promise<ReduceHistoryResult> {
  const safety = ctx.safety ?? 0.8;
  const target = Math.max(2000, Math.floor(newLimit * safety));

  let history = turnHistory.slice();

  // 1. Repack the system prompt at the reduced plan (legacy step, now stage 1).
  if (history.length > 0 && history[0]?.role === "system") {
    try {
      history[0] = {
        ...history[0]!,
        content: repackContextAndSystemPrompt(ctx.input, ctx.route, ctx.plan, ctx.historicalMemories),
      };
    } catch {
      /* repack is best-effort — keep the existing system prompt and reduce the body */
    }
  }

  // 2. Summarize the middle (reuse the canonical compactor; thresholdRatio 0
  //    because we are ALREADY over budget and must always collapse here).
  try {
    const compaction = await compactTurnHistory(history, ctx.provider, newLimit, {
      cacheKey: ctx.cacheKey,
      thresholdRatio: 0,
    });
    history = compaction.messages;
  } catch {
    /* compaction is best-effort — fall through to mechanical trimming */
  }

  // 3. Mechanical reduction until the estimate fits, protecting the system turn
  //    (index 0) and the final/current message (last index).
  let estimate = estimateMessagesTokens(history);
  let guard = 0;
  while (estimate > target && guard++ < 500) {
    const lastIdx = history.length - 1;
    let largestIdx = -1;
    let largestLen = 0;
    for (let i = 1; i < lastIdx; i++) {
      const len = (history[i]?.content ?? "").length;
      if (len > largestLen) {
        largestLen = len;
        largestIdx = i;
      }
    }
    if (largestIdx === -1) break; // only system + final remain — cannot shrink further

    if (largestLen > 2000) {
      // Halve the largest body (keep the head — usually the salient part).
      const c = history[largestIdx]!.content;
      history[largestIdx] = {
        ...history[largestIdx]!,
        content: `${c.slice(0, Math.floor(c.length / 2))}\n…[trimmed to fit context]`,
      };
    } else {
      // Bodies already small → drop the oldest middle turn entirely.
      history.splice(largestIdx, 1);
    }
    estimate = estimateMessagesTokens(history);
  }

  return { messages: history, estimatedTokens: estimate, fits: estimate <= target };
}
