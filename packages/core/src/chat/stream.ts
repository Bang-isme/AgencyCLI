import {
  getProvider,
  loadAgencyConfig,
  getModelSpec,
  isContextLimitError,
  parseContextLimit,
  isTransientError,
  type ProviderId,
} from "@agency/providers";
import {
  buildAtReferenceContext,
  resolveAllFileReferences,
} from "../context/file-refs.js";
import { buildContextPack } from "../context/pack.js";
import { selectContextFiles } from "../context/selector.js";
import { updateKnowledgeGraphForFiles } from "../graph/builder.js";
import {
  getTokenBudgetPlan,
  parseBudgetMode,
} from "../context/token-policy.js";
import { type RouteResult } from "../router/model-router.js";
import { routeToChips } from "./presentation.js";
import {
  appendSuggestedCommands,
  buildSuggestedCommands,
  formatRouteOnlyResponse,
  formatRouteSummary,
  type ChatTurnInput,
  type ChatTurnResult,
} from "./orchestrator.js";
import { providerHasKey, resolveRoute, compactTurnHistory, reduceHistoryToFit, pruneToolResultsInHistory, recordTurnTokenCost, resolveSessionId, resolveRunId, resolveMaxLoops, buildIncompleteTurnNotice, buildCircuitBreakerNotice, detectIncompleteCompletion, detectTruncatedArtifact, buildAutoContinueNudge, buildAutoContinueExhaustedNotice, publishAutoContinueContinuation, MAX_AUTO_CONTINUE, MAX_TOTAL_AUTO_CONTINUE } from "./turn-helpers.js";
import { resolveContextRetryLimit, computeEffectiveContextBudget } from "./context-retry.js";
import { RunManifestRecorder } from "../runtime/run-manifest-store.js";
import { estimateContextBreakdown } from "./context-meter.js";
import {
  buildSynthesisUserMessage,
  markDelegationSynthesisComplete,
  needsDelegationSynthesis,
} from "./delegation-cycle.js";
import { createTraceRecorder } from "./trace-recorder.js";
import { getRuntimeFlags } from "../runtime/flags.js";
import {
  globalCostGovernor,
  globalProviderSupervisor,
} from "../utils/governance-instance.js";
import { buildSystemPrompt } from "./prompt.js";
import { parseToolCalls, stripToolCallsFromText, executeTool, truncateToolResult, isFileWritingTool, resetToolCircuitBreaker, consumeCircuitBreakerTrip, createTurnCircuitBreaker, hasUnclosedToolCall, executeDispatchSubagentFanout, executeDispatchParallel, type ParallelTaskInput } from "../skill/tool-harness.js";
import { consumeBreakerTrip, type CircuitBreakerState } from "./circuit-breaker.js";
import { EventBus } from "../events/event-bus.js";
import { loadHistoricalMemories, safeAddEpisode } from "./memory-integration.js";
import {
  applyLoopMitigation,
  executeTurnToolBatch,
  summarizeToolResult,
} from "./turn-loop.js";

export { summarizeToolResult } from "./turn-loop.js";


/** Extended input with abort signal for cancellation */
export interface ChatStreamInput extends ChatTurnInput {
  signal?: AbortSignal;
}

export interface ChatStreamHandlers {
  onRoute: (payload: ChatRouteEvent) => void;
  onDelta: (delta: string) => void;
  onThought?: (thoughtDelta: string) => void;
  onOptimization?: (optimization: { budget: number; intent: string; type: "budget" | "effort" | "none" }) => void;
  onUsage?: (usage: { promptTokens: number; completionTokens: number; reasoningTokens?: number }) => void;
}

export interface ChatRouteEvent {
  route: RouteResult;
  chips: ReturnType<typeof routeToChips>;
  suggestedCommands: string[];
  routeFromCache: boolean;
  routeOnly: boolean;
}

function formatToolCallNotice(name: string, args: Record<string, any>): string {
  if (name === "dispatch_subagent") {
    const workerName = args.agentId ? `worker.${args.agentId}` : "subagent";
    return `\n\n⚡ [SYSTEM: Spawning specialist ${workerName}...]\n`;
  }
  if (name === "dispatch_parallel") {
    return `\n\n⚡ [SYSTEM: Spawning parallel subagent batch...]\n`;
  }

  const filePath = args.path || args.AbsolutePath || args.TargetFile || "";
  const start = args.StartLine || args.start_line || args.start;
  const end = args.EndLine || args.end_line || args.end;

  let linesRange = "";
  if (start !== undefined && end !== undefined) {
    linesRange = ` (lines ${start}-${end})`;
  } else if (start !== undefined) {
    linesRange = ` (from line ${start})`;
  } else if (name === "read_file" || name === "view_file") {
    const defaultRead = name === "view_file" ? 800 : 300;
    linesRange = ` (lines 1-${defaultRead})`;
  } else if (name === "multi_replace_file_content" && Array.isArray(args.ReplacementChunks)) {
    const chunkRanges = args.ReplacementChunks.map((c: any) => `${c.StartLine}-${c.EndLine}`).join(", ");
    linesRange = ` (chunks at lines ${chunkRanges})`;
  }

  if (filePath) {
    return `\n\n⚡ [SYSTEM: Executing tool "${name}" on ${filePath}${linesRange}...]\n`;
  }

  const cleanArgs: Record<string, any> = { ...args };
  if (cleanArgs.task && typeof cleanArgs.task === "string" && cleanArgs.task.length > 60) {
    cleanArgs.task = cleanArgs.task.slice(0, 60) + "...";
  }
  if (cleanArgs.content && typeof cleanArgs.content === "string" && cleanArgs.content.length > 60) {
    cleanArgs.content = cleanArgs.content.slice(0, 60) + "...";
  }
  return `\n\n⚡ [SYSTEM: Executing tool "${name}" with arguments ${JSON.stringify(cleanArgs)}...]\n`;
}

function shouldEmitLegacyToolText(name: string): boolean {
  return name !== "update_plan" && process.env.AGENCY_TOOL_TEXT_NOTICES === "1";
}

export async function runChatTurnWithStream(
  input: ChatStreamInput,
  handlers: ChatStreamHandlers
): Promise<ChatTurnResult> {
  const resolvedSessionId = resolveSessionId(input.sessionId);
  const runId = resolveRunId(input.runId, resolvedSessionId);
  const recorder = new RunManifestRecorder(input.projectRoot, runId, resolvedSessionId);
  const historicalMemories = await loadHistoricalMemories(input.projectRoot, input.prompt, resolvedSessionId);

  // Ingest user prompt at the start of the turn
  safeAddEpisode(
    input.projectRoot,
    resolvedSessionId,
    input.prompt,
    0,
    "user_input",
    input.prompt
  );

  const budget = parseBudgetMode(input.budget);
  const initialPlan = getTokenBudgetPlan(budget);
  const { route, fromCache } = await resolveRoute(input, initialPlan);

  const config = loadAgencyConfig();

  // 1. Enforce Cost budget hard-freeze
  const costState = globalCostGovernor.getGovernanceState();
  if (costState.isDepleted) {
    throw new Error(`[Cost Governance Depleted] Budget limit of $${costState.budgetLimit.toFixed(2)} exceeded. Execution frozen.`);
  }

  let requestedProviderId = input.providerId ?? route.provider;

  // 2. Auto model downgrade at 75% spend
  if (costState.shouldDowngrade && requestedProviderId === "anthropic") {
    requestedProviderId = "google";
  }

  // 3. Provider Failover Switch
  const providerId = globalProviderSupervisor.getOptimalProvider(requestedProviderId) as any;
  const modelName = config.providers[providerId as ProviderId]?.model || (config.providers as any)[providerId]?.defaultModel;

  // Resolve the adaptive token budget plan based on the resolved modelName (A1).
  // Provider-aware so the budget uses the conservative context window for THIS
  // provider (model-catalog clamps a wrong-high catalog entry down).
  let plan = getTokenBudgetPlan(budget, modelName, providerId);

  const routeSummary = formatRouteSummary(route);
  const suggestedCommands = buildSuggestedCommands(
    route,
    input.projectRoot,
    input.prompt
  );

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
  const contextFiles = [
    ...new Set([
      ...selectContextFiles(input.projectRoot, route, plan, input.prompt),
      ...atRefs,
    ]),
  ];

  const useLlm = !input.noLlm && providerHasKey(providerId, config);

  handlers.onRoute({
    route,
    chips: routeToChips(route),
    suggestedCommands,
    routeFromCache: fromCache,
    routeOnly: !useLlm,
  });

  if (!useLlm) {
    const text = formatRouteOnlyResponse(
      route,
      routeSummary,
      suggestedCommands,
      plan
    );
    const hint = fromCache ? "\n(route cache hit)" : "";
    return {
      route,
      routeSummary,
      assistantText: text + hint,
      suggestedCommands,
      routeOnly: true,
      budget,
      contextFiles,
      routeFromCache: fromCache,
    };
  }

  const startTime = Date.now();
  const traceRecorder = createTraceRecorder(input.projectRoot, resolvedSessionId, input.prompt);
  let llmText = "";
  const filesWritten = new Set<string>();
  const aggregatedUsage = { promptTokens: 0, completionTokens: 0, reasoningTokens: 0 };
  let resolvedOptimization: any = undefined;
  let loopCount = 0;
  // Per-turn monotonic counter for tool-lifecycle events (Phase A — so the
  // Activity Timeline can order them deterministically).
  let toolEventSeq = 0;

  try {
    let provider = getProvider(config, providerId);
    let lastFinishReason = "";

    let turnHistory = [
      {
        role: "system" as const,
        content: buildSystemPrompt(route, input.prompt, contextPack, input.projectRoot, input.history, input.systemInstructionOverride, historicalMemories),
      },
      ...(input.history || []),
      { role: "user" as const, content: input.prompt },
    ];

    // §2.3 — compact a long history before it overflows the window. Run before
    // the loop (initial history) AND at the top of each iteration, so the tool
    // results accumulating across iterations are compacted too — the reactive
    // context-limit handler shrinks the window but never the conversation, so a
    // long tool-loop could still overflow mid-turn. No-op under threshold and
    // byte-identical when the flag is off; the cacheKey makes the repeated
    // in-loop compactions incremental (O(new turns), not O(all)).
    const compactIfEnabled = async (): Promise<void> => {
      if (!getRuntimeFlags().contextCompaction) return;
      const spec = getModelSpec(modelName, providerId);
      const effective = computeEffectiveContextBudget(spec.contextWindow, spec.maxOutputTokens);
      const compaction = await compactTurnHistory(
        turnHistory,
        provider,
        effective,
        { cacheKey: resolvedSessionId, thresholdRatio: 0.62 }
      );
      turnHistory = compaction.messages;
      turnHistory = pruneToolResultsInHistory(turnHistory);
    };
    await compactIfEnabled();

    void EventBus.getInstance().publish("context:meter", {
      sessionId: resolvedSessionId,
      ...estimateContextBreakdown({
        turnMessages: turnHistory,
        model: modelName,
        providerId,
      }),
    });

    loopCount = 0;
    let autoContinueCount = 0; // consecutive narration-only stops without productive tools
    let totalAutoContinueCount = 0; // whole-turn cap (prevents read→narrate loops)
    // §8.10 — partial tool-call XML carried across token-limit continuations so a
    // write_file split by the output limit reassembles into one executable call.
    let carryOverText = "";
    const MAX_TOOLCALL_CARRYOVER = 1_000_000; // give up reassembly past ~1MB
    // A per-turn breaker (scoped path) isolates this turn from its subagents and
    // parallel subagents from each other; the legacy path resets one shared
    // module breaker, which a dispatched subagent would wipe mid-turn.
    const turnBreaker: CircuitBreakerState | null = getRuntimeFlags().scopedCircuitBreaker
      ? createTurnCircuitBreaker()
      : null;
    if (!turnBreaker) resetToolCircuitBreaker();
    // `let` so Phase E (autoContinueOnExhaustion) can extend the cap while the
    // turn keeps making real progress. The original value bounds the extension.
    let maxLoops = resolveMaxLoops(budget, input.maxLoops);
    const baseMaxLoops = maxLoops;
    const hardLoopCeiling = baseMaxLoops * 4; // absolute runaway backstop
    let filesAtLastExtension = 0; // grows only when NEW files are written

    // Phase E: when a productive iteration would exhaust the loop budget, extend
    // it ONE window instead of stopping with "send continue" — but only while the
    // set of files written keeps GROWING (no-progress window stops it) and only up
    // to the hard ceiling. The circuit breaker independently halts churn. Called
    // right after a productive loopCount++ so the `while` keeps running.
    const extendLoopBudgetIfProgressing = (): void => {
      if (
        getRuntimeFlags().autoContinueOnExhaustion &&
        loopCount >= maxLoops &&
        loopCount < hardLoopCeiling &&
        filesWritten.size > filesAtLastExtension
      ) {
        filesAtLastExtension = filesWritten.size;
        maxLoops = Math.min(hardLoopCeiling, maxLoops + baseMaxLoops);
        void EventBus.getInstance().publish("continuation:started", {
          turnId: resolvedSessionId,
          loopCount,
          maxLoops,
          filesModified: filesWritten.size,
        });
      }
    };

    let inSynthesisTurn = false;

    const CONTEXT_METER_THROTTLE_MS = 200;
    let lastContextMeterMs = 0;
    const publishContextMeter = (
      inflightAssistantText?: string,
      inflightThoughtText?: string
    ): void => {
      void EventBus.getInstance().publish("context:meter", {
        sessionId: resolvedSessionId,
        ...estimateContextBreakdown({
          turnMessages: turnHistory,
          model: modelName,
          providerId,
          inflightAssistantText,
          inflightThoughtText,
        }),
      });
    };

    while (loopCount < maxLoops) {
      await compactIfEnabled();

      void EventBus.getInstance().publish("turn:phase", {
        phase: "llm",
        loopCount,
        maxLoops,
        sessionId: resolvedSessionId,
      });

      void EventBus.getInstance().publish("context:meter", {
        sessionId: resolvedSessionId,
        ...estimateContextBreakdown({
          turnMessages: turnHistory,
          model: modelName,
          providerId,
        }),
      });

      lastFinishReason = "";
      let currentText = "";
      let currentThought = "";

      let completionSuccess = false;
      let attempt = 0;
      const maxAttempts = 3;
      let transientAttempt = 0;
      const maxTransientAttempts = 3;

      while (!completionSuccess) {
        const llmOpts = {
          maxTokens: Math.round(plan.maxLlmOutputTokens * (input.reasoningBudgetMultiplier ?? 1.0)),
          onDelta: (delta: string) => {
            currentText += delta;
            handlers.onDelta(delta);
            const now = Date.now();
            if (now - lastContextMeterMs >= CONTEXT_METER_THROTTLE_MS) {
              lastContextMeterMs = now;
              publishContextMeter(currentText, currentThought);
            }
          },
          onThought: (thoughtDelta: string) => {
            currentThought += thoughtDelta;
            handlers.onThought?.(thoughtDelta);
            const now = Date.now();
            if (now - lastContextMeterMs >= CONTEXT_METER_THROTTLE_MS) {
              lastContextMeterMs = now;
              publishContextMeter(currentText, currentThought);
            }
          },
          onFinishReason: (reason: string) => {
            lastFinishReason = reason;
          },
          onUsage: (usage: any) => {
            aggregatedUsage.promptTokens += usage.promptTokens;
            aggregatedUsage.completionTokens += usage.completionTokens;
            if (usage.reasoningTokens) {
              aggregatedUsage.reasoningTokens += usage.reasoningTokens;
            }
            handlers.onUsage?.({
              promptTokens: usage.promptTokens,
              completionTokens: usage.completionTokens,
              reasoningTokens: usage.reasoningTokens,
            });
          },
          onOptimization: (opt: any) => {
            resolvedOptimization = opt;
            handlers.onOptimization?.(opt);
          },
          signal: input.signal,
          // Same flag as the static-prefix reorder: let the Anthropic adapter
          // cache the (now stable-prefix) system prompt across turns.
          cacheSystemPrompt: getRuntimeFlags().promptCachePrefix,
        };

        try {
          if (provider.streamComplete) {
            await provider.streamComplete(turnHistory, llmOpts);
          } else {
            const text = await provider.complete(turnHistory, llmOpts);
            llmOpts.onDelta(text);
          }
          completionSuccess = true;
        } catch (err: any) {
          if (isContextLimitError(err) && attempt < maxAttempts) {
            attempt++;
            const catalogSpec = getModelSpec(modelName, providerId);
            const oldLimit = catalogSpec.contextWindow;
            const parsedLimit = parseContextLimit(err.message || String(err));
            const trimLimit = resolveContextRetryLimit(
              resolvedSessionId,
              modelName,
              providerId,
              parsedLimit
            );

            if (trimLimit > 8192) {
              const updatedPlan = getTokenBudgetPlan(budget, modelName, providerId);
              plan = updatedPlan;

              const reduction = await reduceHistoryToFit(turnHistory, trimLimit, {
                input,
                route,
                plan: updatedPlan,
                historicalMemories,
                provider,
                cacheKey: resolvedSessionId,
              });
              turnHistory = reduction.messages;
              turnHistory = pruneToolResultsInHistory(turnHistory);

              void EventBus.getInstance().publish("system:warning", {
                message: `Context limit exceeded for model ${modelName}. Reduced conversation to ~${reduction.estimatedTokens} est tokens (catalog window ${oldLimit}${parsedLimit ? `, provider reported ${parsedLimit}` : ""})${reduction.fits ? "" : " — still tight"} and retrying...`
              });

              currentText = "";
              continue;
            }
          }

          if (isTransientError(err) && transientAttempt < maxTransientAttempts) {
            transientAttempt++;
            const baseDelay = 2000 * Math.pow(2, transientAttempt - 1);
            const jitter = Math.random() * baseDelay * 0.3;
            const finalDelay = baseDelay + jitter;
            const seconds = (finalDelay / 1000).toFixed(1);

            const warningMsg = `⚠️ [Stream Failsafe Recovery] LLM request failed with transient error. Retrying in ${seconds}s (Attempt ${transientAttempt}/${maxTransientAttempts})...`;
            
            void EventBus.getInstance().publish("system:warning", { message: warningMsg });
            console.warn(`\x1b[33m${warningMsg}\x1b[0m`);

            await new Promise((resolve) => setTimeout(resolve, finalDelay));
            currentText = "";
            continue;
          }

          throw err;
        }
      }

      llmText += currentText;
      traceRecorder?.recordLlmResponse(currentText, lastFinishReason);
      publishContextMeter(currentText, currentThought);

      // Check for XML tool calls. When reassembly is on and a previous
      // completion left a partial (length-truncated) tool call, parse the
      // combined buffer so a split write_file resolves into one complete call.
      const reassembleToolCalls = getRuntimeFlags().toolCallReassembly;
      const toolCallSource = reassembleToolCalls && carryOverText ? carryOverText + currentText : currentText;
      const toolCalls = parseToolCalls(toolCallSource);
      if (toolCalls.length > 0) {
        carryOverText = ""; // consumed — the call(s) parsed completely
        const turnAgentId = input.agentId || process.env.AGENCY_AGENT_ID;
        const modelName = config.providers[providerId as ProviderId]?.model || (config.providers as any)[providerId]?.defaultModel;
        const toolOutputs = await executeTurnToolBatch({
          toolCalls,
          projectRoot: input.projectRoot,
          skillsRoot: input.skillsRoot,
          sessionId: resolvedSessionId,
          prompt: input.prompt,
          loopCount,
          modelName,
          signal: input.signal,
          breaker: turnBreaker,
          toolEventAgentId: turnAgentId || "main",
          subagentProgressAgentId: turnAgentId,
          isFileWritingTool,
          executeTool,
          truncateToolResult,
          nextToolEventSeq: () => toolEventSeq++,
          onToolStartedText: (tc) => {
            if (shouldEmitLegacyToolText(tc.name)) {
              handlers.onDelta(formatToolCallNotice(tc.name, tc.arguments));
            }
          },
          onToolFinishedText: (tc, result) => {
            if (shouldEmitLegacyToolText(tc.name)) {
              handlers.onDelta(`⚡ [SYSTEM: Tool "${tc.name}" completed: ${summarizeToolResult(tc.name, result, tc.arguments)}]\n`);
            }
          },
          onFilesWritten: (path) => filesWritten.add(path),
          recordTool: (name, args, result) => traceRecorder?.recordTool(name, args, result),
          executeDispatchSubagentFanout,
          executeDispatchParallel: (batchLabel, tasks, root, sk, sig, sid) =>
            executeDispatchParallel(
              root,
              batchLabel,
              tasks as unknown as ParallelTaskInput[],
              sk,
              sig,
              sid
            ),
          synthesisMode: inSynthesisTurn,
        });

        await applyLoopMitigation({
          breaker: turnBreaker,
          toolCalls,
          turnHistory,
          agentId: input.agentId,
          conversationId: resolvedSessionId,
          projectRoot: input.projectRoot,
          waitForResume: input.loopMitigationWaitForResume,
          onPause: () => handlers.onDelta(`\n⏸️ [Live Grill] Loop paused. Waiting for user input or rollback...\n`),
          onResume: () => handlers.onDelta(`\n▶️ [Live Grill] Resuming execution with steering instructions.\n`),
        });

        turnHistory = [
          ...turnHistory,
          { role: "assistant" as const, content: stripToolCallsFromText(currentText) },
          { role: "user" as const, content: toolOutputs },
        ];
        turnHistory = pruneToolResultsInHistory(turnHistory);

        if (needsDelegationSynthesis(resolvedSessionId) && !inSynthesisTurn) {
          const synthMsg = buildSynthesisUserMessage(resolvedSessionId);
          if (synthMsg) {
            turnHistory.push({ role: "user" as const, content: synthMsg });
            inSynthesisTurn = true;
            loopCount++;
            extendLoopBudgetIfProgressing();
            continue;
          }
        }

        // §8.8-A — the circuit breaker tripped inside executeTool (identical calls
        // or consecutive failures). It used to only return an Error string the
        // model kept ignoring, churning to maxLoops. Hard-break the loop and fold
        // a final notice into the turn text so the user/next turn see why it
        // stopped. The tool results are already in turnHistory above.
        const breakerReason = turnBreaker ? consumeBreakerTrip(turnBreaker) : consumeCircuitBreakerTrip();
        if (breakerReason) {
          const notice = buildCircuitBreakerNotice(breakerReason);
          handlers.onDelta(`\n${notice}\n`);
          llmText += `\n${notice}`;
          EventBus.getInstance().publish("system:warning", {
            message: `Tool loop halted by circuit breaker after repeated failed/identical tool calls.`,
          });
          break;
        }

        loopCount++;
        if (
          toolCalls.some(
            (tc) =>
              isFileWritingTool(tc.name) ||
              tc.name === "update_plan" ||
              tc.name === "dispatch_subagent" ||
              tc.name === "dispatch_parallel"
          )
        ) {
          autoContinueCount = 0;
        }
        extendLoopBudgetIfProgressing();
        continue;
      }

      const lowerReason = lastFinishReason.toLowerCase();
      const isLengthFinish = lowerReason === "length" || lowerReason === "max_tokens" || lowerReason === "max_token_tokens" || lowerReason === "max_tokens_budget";
      const isSilentTruncation = reassembleToolCalls && hasUnclosedToolCall(toolCallSource);
      if (isLengthFinish || isSilentTruncation) {
        // If the cut-off happened mid tool call (e.g. a large write_file whose
        // content overflowed the response), carry the partial XML forward so the
        // next completion's tail reassembles into a complete, executable call —
        // otherwise the write is silently dropped and the model churns. Bounded
        // to avoid unbounded growth; off → carryOverText stays "" (legacy).
        carryOverText =
          reassembleToolCalls &&
          hasUnclosedToolCall(toolCallSource) &&
          toolCallSource.length <= MAX_TOOLCALL_CARRYOVER
            ? toolCallSource
            : "";
        turnHistory = [
          ...turnHistory,
          { role: "assistant" as const, content: stripToolCallsFromText(currentText) },
          {
            role: "user" as const,
            content: "You were cut off because of token limit limits. Continue exactly where you left off without any preamble, greeting, or repetitive sentences. Maintain the exact formatting structure, including active markdown code blocks or SEARCH/REPLACE blocks without duplication.",
          },
        ];
        loopCount++;
        extendLoopBudgetIfProgressing();
      } else if (
        getRuntimeFlags().autoContinue &&
        autoContinueCount < MAX_AUTO_CONTINUE &&
        totalAutoContinueCount < MAX_TOTAL_AUTO_CONTINUE &&
        (detectIncompleteCompletion(currentText) ||
          (filesWritten.size > 0 && detectTruncatedArtifact(filesWritten, input.projectRoot)))
      ) {
        // Completion-quality check: a no-tool-call turn normally ENDS the loop,
        // but the task looks unfinished — the model promised to continue (prose),
        // OR a file it wrote this turn still has an on-disk "…rest of the code"
        // placeholder (artifact-based, stronger: catches a clean-looking "Done."
        // hiding a saved stub). Nudge it to resume from the on-disk state and run
        // another (bounded) iteration instead of returning a half-done turn the
        // user must manually continue. Off → byte-identical break (legacy);
        // capped by MAX_AUTO_CONTINUE within maxLoops.
        autoContinueCount++;
        totalAutoContinueCount++;
        carryOverText = ""; // a normal (non-tool, non-length) completion — drop any partial
        publishAutoContinueContinuation(autoContinueCount, MAX_AUTO_CONTINUE);
        turnHistory = [
          ...turnHistory,
          { role: "assistant" as const, content: stripToolCallsFromText(currentText) },
          { role: "user" as const, content: buildAutoContinueNudge(filesWritten, input.projectRoot, autoContinueCount) },
        ];
        loopCount++;
        extendLoopBudgetIfProgressing();
      } else {
        carryOverText = "";
        if (
          getRuntimeFlags().autoContinue &&
          (autoContinueCount >= MAX_AUTO_CONTINUE ||
            totalAutoContinueCount >= MAX_TOTAL_AUTO_CONTINUE) &&
          (detectIncompleteCompletion(currentText) ||
            (filesWritten.size > 0 && detectTruncatedArtifact(filesWritten, input.projectRoot)))
        ) {
          const cap = totalAutoContinueCount >= MAX_TOTAL_AUTO_CONTINUE
            ? MAX_TOTAL_AUTO_CONTINUE
            : MAX_AUTO_CONTINUE;
          const notice = buildAutoContinueExhaustedNotice(
            cap,
            filesWritten,
            input.projectRoot
          );
          handlers.onDelta(`\n${notice}\n`);
          llmText += `\n${notice}`;
          void EventBus.getInstance().publish("system:warning", {
            message: `Turn paused after ${cap} resume attempt(s) — send "continue" to pick up where it stopped.`,
          });
        }
        if (inSynthesisTurn) {
          markDelegationSynthesisComplete(resolvedSessionId);
          inSynthesisTurn = false;
        }
        break;
      }
    }

    // Warn user if the loop was exhausted rather than completing naturally
    if (loopCount >= maxLoops) {
      // A subagent run can't be user-continued ("send continue" resumes the MAIN
      // turn, not this worker), so the surfaced notice must not tell the user to.
      const subagentId = input.agentId || process.env.AGENCY_AGENT_ID;
      if (getRuntimeFlags().resumeContinuation) {
        // §8.10 — fold an informative, resume-oriented notice into the turn text
        // (not just a transient onDelta) so the NEXT turn's history records what
        // was in progress and a "continue" appends from the on-disk state instead
        // of restarting from scratch.
        const notice = buildIncompleteTurnNotice(filesWritten, input.projectRoot, maxLoops);
        handlers.onDelta(`\n${notice}\n`);
        llmText += `\n${notice}`;
        EventBus.getInstance().publish("system:warning", {
          message: subagentId
            ? `Subagent ${subagentId} hit its max loop limit (${maxLoops})${filesWritten.size > 0 ? ` after modifying ${filesWritten.size} file(s)` : ""}.`
            : `Chat stream hit max loop limit (${maxLoops}). ${filesWritten.size > 0 ? `Modified ${filesWritten.size} file(s); send "continue" to resume.` : "Response may be incomplete."}`,
        });
      } else {
        const truncMsg = `⚠ [SYSTEM: Response truncated — reached maximum ${maxLoops} continuation/tool iterations. Some output may be incomplete.]`;
        handlers.onDelta(`\n${truncMsg}\n`);
        EventBus.getInstance().publish("system:warning", {
          message: `Chat stream hit max loop limit (${maxLoops}). Response may be incomplete.`,
        });
      }
    }

    const duration = Date.now() - startTime;
    globalProviderSupervisor.recordCall(providerId, duration, true);

    // Record actual or estimated tokens cost (shared estimate — see turn-helpers).
    recordTurnTokenCost(aggregatedUsage, contextPack, llmText, providerId);
    traceRecorder?.recordTurn(duration);
    traceRecorder?.save();
  } catch (err) {
    const duration = Date.now() - startTime;
    globalProviderSupervisor.recordCall(providerId, duration, false);
    throw err;
  }

  if (filesWritten.size > 0) {
    try {
      await updateKnowledgeGraphForFiles(input.projectRoot, Array.from(filesWritten));
    } catch (kgErr: any) {
      EventBus.getInstance().publish("system:warning", {
        message: `Knowledge graph update failed: ${kgErr.message || String(kgErr)}`,
      });
    }
  }

  safeAddEpisode(
    input.projectRoot,
    resolvedSessionId,
    input.prompt,
    loopCount,
    "assistant_reply",
    llmText
  );

  recorder.finishRun("succeeded", `Completed streaming turn for session ${resolvedSessionId}`);

  return {
    route,
    routeSummary,
    assistantText: appendSuggestedCommands(llmText, suggestedCommands),
    suggestedCommands,
    routeOnly: false,
    budget,
    contextFiles,
    routeFromCache: fromCache,
    filesWritten: Array.from(filesWritten),
    completionMetadata: {
      thinkingBudget: resolvedOptimization?.budget,
      taskIntent: resolvedOptimization?.intent,
      promptTokens: aggregatedUsage.promptTokens,
      completionTokens: aggregatedUsage.completionTokens,
      reasoningTokens: aggregatedUsage.reasoningTokens,
      modelSpec: getModelSpec(modelName),
    },
  };
}
