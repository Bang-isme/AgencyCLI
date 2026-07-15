import {
  getProvider,
  loadAgencyConfig,
  getModelSpec,
  isContextLimitError,
  parseContextLimit,
  isTransientError,
  type ProviderId,
  type ModelSpec,
  type ChatMessage,
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
  type BudgetMode,
  type TokenBudgetPlan,
} from "../context/token-policy.js";
import { type RouteResult } from "../router/model-router.js";
import { globalCostGovernor, globalProviderSupervisor } from "../utils/governance-instance.js";
import { buildSystemPrompt } from "./prompt.js";
import { formatRouteSummary, buildSuggestedCommands } from "./route-presentation.js";
import { providerHasKey, resolveRoute, compactTurnHistory, reduceHistoryToFit, pruneToolResultsInHistory, recordTurnTokenCost, resolveSessionId, resolveMaxLoops, buildIncompleteTurnNotice, buildCircuitBreakerNotice, detectIncompleteCompletion, detectTruncatedArtifact, buildAutoContinueNudge, buildAutoContinueExhaustedNotice, publishAutoContinueContinuation, MAX_AUTO_CONTINUE, MAX_TOTAL_AUTO_CONTINUE } from "./turn-helpers.js";
import { createTraceRecorder } from "./trace-recorder.js";
import { getRuntimeFlags } from "../runtime/flags.js";
import { parseToolCalls, stripToolCallsFromText, executeTool, truncateToolResult, isFileWritingTool, resetToolCircuitBreaker, consumeCircuitBreakerTrip, createTurnCircuitBreaker, hasUnclosedToolCall, executeDispatchSubagentFanout } from "../skill/tool-harness.js";
import { resolveContextRetryLimit } from "./context-retry.js";
import { consumeBreakerTrip, type CircuitBreakerState } from "./circuit-breaker.js";
import { EventBus } from "../events/event-bus.js";
import { loadHistoricalMemories, safeAddEpisode } from "./memory-integration.js";
import { applyLoopMitigation, executeTurnToolBatch } from "./turn-loop.js";



// `ChatMessage` ({ role, content }) is owned by @agency/providers (the LLM
// layer). Re-exported here so the many `import { ChatMessage } from
// "./orchestrator.js"` consumers keep one import path, while the type has a
// single definition — it was previously a byte-identical duplicate declaration.
import { resolveRunId } from "./turn-helpers.js";
import { RunManifestRecorder } from "../runtime/run-manifest-store.js";

export type { ChatMessage };

export interface ChatTurnInput {
  prompt: string;
  projectRoot: string;
  skillsRoot: string;
  providerId?: ProviderId;
  noLlm?: boolean;
  budget?: BudgetMode;
  history?: ChatMessage[];
  systemInstructionOverride?: string;
  agentId?: string;
  noVerify?: boolean;
  reasoningBudgetMultiplier?: number;
  maxLoops?: number;
  sessionId?: string;
  runId?: string;
  loopMitigationWaitForResume?: boolean;
}

export interface ChatTurnResult {
  route: RouteResult;
  routeSummary: string;
  assistantText: string;
  suggestedCommands: string[];
  routeOnly: boolean;
  budget: BudgetMode;
  contextFiles: string[];
  routeFromCache: boolean;
  filesWritten?: string[];
  completionMetadata?: {
    thinkingBudget?: number | string;
    taskIntent?: string;
    promptTokens?: number;
    completionTokens?: number;
    reasoningTokens?: number;
    modelSpec?: ModelSpec;
  };
}

// `formatRouteSummary` + `buildSuggestedCommands` live in the leaf module
// `route-presentation.ts` (pure route→string helpers) so the context and
// agents/skill layers no longer import this orchestrator — that back-edge formed
// a runtime import cycle. Re-exported here so existing `from "./orchestrator.js"`
// consumers (index.ts, stream.ts, agents/orchestrator.ts) keep one import path.
export { formatRouteSummary, buildSuggestedCommands };

export function formatRouteOnlyResponse(
  route: RouteResult,
  routeSummary: string,
  _suggestedCommands: string[],
  plan: TokenBudgetPlan
): string {
  const lines = [routeSummary];
  if (plan.includeFullRouteJson) {
    lines.push("", JSON.stringify(route, null, 2));
  }
  return lines.join("\n");
}

export function appendSuggestedCommands(
  text: string,
  _suggestedCommands: string[]
): string {
  return text;
}export async function runChatTurn(
  input: ChatTurnInput
): Promise<ChatTurnResult> {
  const resolvedSessionId = resolveSessionId(input.sessionId);
  const runId = resolveRunId(input.runId, resolvedSessionId);
  const recorder = new RunManifestRecorder(input.projectRoot, runId, resolvedSessionId);
  let terminalStatus: "succeeded" | "failed" | "incomplete" | "cancelled" = "succeeded";
  let terminalSummary = `Completed turn for session ${resolvedSessionId}`;

  try {
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
      terminalStatus = "cancelled";
      terminalSummary = "Cost budget depleted";
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

    if (!useLlm) {
      const text = formatRouteOnlyResponse(
        route,
        routeSummary,
        suggestedCommands,
        plan
      );
      const hint = fromCache ? "\n(route cache hit)" : "";
      terminalStatus = "succeeded";
      terminalSummary = `Completed route-only turn for session ${resolvedSessionId}`;
      return {
        route,
        routeSummary,
        assistantText: text + hint,
        suggestedCommands,
        routeOnly: true,
        budget,
        contextFiles,
        routeFromCache: fromCache,
        filesWritten: [],
        completionMetadata: {
          thinkingBudget: undefined,
          promptTokens: 0,
          completionTokens: 0,
          reasoningTokens: 0,
          modelSpec: getModelSpec(modelName, providerId),
        },
      };
    }

  const startTime = Date.now();
  const traceRecorder = createTraceRecorder(input.projectRoot, resolvedSessionId, input.prompt);
  let llmText = "";
  const filesWritten = new Set<string>();
  const aggregatedUsage = { promptTokens: 0, completionTokens: 0, reasoningTokens: 0 };
  let resolvedOptimization: any = undefined;
  let loopCount = 0;

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
      const compaction = await compactTurnHistory(
        turnHistory,
        provider,
        getModelSpec(modelName, providerId).contextWindow,
        { cacheKey: resolvedSessionId }
      );
      turnHistory = compaction.messages;
    };
    await compactIfEnabled();

    loopCount = 0;
    let autoContinueCount = 0;
    let totalAutoContinueCount = 0;
    // §8.10 — partial tool-call XML carried across token-limit continuations so a
    // write_file split by the output limit reassembles into one executable call.
    let carryOverText = "";
    const MAX_TOOLCALL_CARRYOVER = 1_000_000; // give up reassembly past ~1MB
    // A per-turn breaker (scoped path) isolates this turn from its subagents;
    // the legacy path resets one shared module breaker (a dispatched subagent
    // would wipe this turn's breaker mid-flight). See the scopedCircuitBreaker flag.
    const turnBreaker: CircuitBreakerState | null = getRuntimeFlags().scopedCircuitBreaker
      ? createTurnCircuitBreaker()
      : null;
    if (!turnBreaker) resetToolCircuitBreaker();
    const maxLoops = resolveMaxLoops(budget, input.maxLoops);

    while (loopCount < maxLoops) {
      await compactIfEnabled();
      lastFinishReason = "";
      let currentText = "";
      let completionSuccess = false;
      let attempt = 0;
      const maxAttempts = 3;
      let transientAttempt = 0;
      const maxTransientAttempts = 3;

      while (!completionSuccess) {
        try {
          currentText = await provider.complete(
            turnHistory,
            {
              maxTokens: Math.round(plan.maxLlmOutputTokens * (input.reasoningBudgetMultiplier ?? 1.0)),
              onFinishReason: (reason) => {
                lastFinishReason = reason;
              },
              onUsage: (usage) => {
                aggregatedUsage.promptTokens += usage.promptTokens;
                aggregatedUsage.completionTokens += usage.completionTokens;
                if (usage.reasoningTokens) {
                  aggregatedUsage.reasoningTokens += usage.reasoningTokens;
                }
              },
              onOptimization: (opt) => {
                resolvedOptimization = opt;
              },
              // Same flag as the static-prefix reorder: let the Anthropic
              // adapter cache the (stable-prefix) system prompt across turns.
              cacheSystemPrompt: getRuntimeFlags().promptCachePrefix,
            }
          );
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

            const warningMsg = `⚠️ [Turn Failsafe Recovery] LLM request failed with transient error. Retrying in ${seconds}s (Attempt ${transientAttempt}/${maxTransientAttempts})...`;
            
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
          breaker: turnBreaker,
          toolEventAgentId: turnAgentId || "main",
          subagentProgressAgentId: turnAgentId,
          isFileWritingTool,
          executeTool,
          truncateToolResult,
          onFilesWritten: (path) => filesWritten.add(path),
          recordTool: (name, args, result) => traceRecorder?.recordTool(name, args, result),
          executeDispatchSubagentFanout,
        });

        await applyLoopMitigation({
          breaker: turnBreaker,
          toolCalls,
          turnHistory,
          agentId: input.agentId,
          conversationId: resolvedSessionId,
          projectRoot: input.projectRoot,
          waitForResume: input.loopMitigationWaitForResume,
        });

        turnHistory = [
          ...turnHistory,
          { role: "assistant" as const, content: stripToolCallsFromText(currentText) },
          { role: "user" as const, content: toolOutputs },
        ];

        // §8.8-A — hard-break on a circuit-breaker trip (see stream.ts). The
        // non-stream path has no onDelta, so the notice reaches the user + the
        // next turn only via llmText → assistantText → history.
        const breakerReason = turnBreaker ? consumeBreakerTrip(turnBreaker) : consumeCircuitBreakerTrip();
        if (breakerReason) {
          llmText += `\n${buildCircuitBreakerNotice(breakerReason)}`;
          void EventBus.getInstance().publish("system:warning", {
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
        continue;
      }

      const lowerReason = lastFinishReason.toLowerCase();
      const isLengthFinish = lowerReason === "length" || lowerReason === "max_tokens" || lowerReason === "max_token_tokens" || lowerReason === "max_tokens_budget";
      const isSilentTruncation = reassembleToolCalls && hasUnclosedToolCall(toolCallSource);
      if (isLengthFinish || isSilentTruncation) {
        // Carry a tool call cut off mid-content forward so the next completion's
        // tail reassembles it (see stream.ts); off → carryOverText stays "".
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
      } else if (
        getRuntimeFlags().autoContinue &&
        autoContinueCount < MAX_AUTO_CONTINUE &&
        totalAutoContinueCount < MAX_TOTAL_AUTO_CONTINUE &&
        (detectIncompleteCompletion(currentText) ||
          (filesWritten.size > 0 && detectTruncatedArtifact(filesWritten, input.projectRoot)))
      ) {
        // Completion-quality check (see stream.ts): the task looks unfinished —
        // the model promised to continue (prose) OR a file it wrote still has an
        // on-disk "…rest of the code" placeholder. Nudge it to resume from the
        // on-disk state and run another bounded iteration instead of returning a
        // half-done turn. Off → byte-identical break (legacy).
        autoContinueCount++;
        totalAutoContinueCount++;
        carryOverText = "";
        publishAutoContinueContinuation(autoContinueCount, MAX_AUTO_CONTINUE);
        turnHistory = [
          ...turnHistory,
          { role: "assistant" as const, content: stripToolCallsFromText(currentText) },
          { role: "user" as const, content: buildAutoContinueNudge(filesWritten, input.projectRoot, autoContinueCount) },
        ];
        loopCount++;
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
          llmText += `\n${notice}`;
          void EventBus.getInstance().publish("system:warning", {
            message: `Turn paused after ${cap} resume attempt(s) — send "continue" to pick up where it stopped.`,
          });
        }
        break;
      }
    }

    if (loopCount >= maxLoops) {
      if (getRuntimeFlags().resumeContinuation) {
        // §8.10 — persist a resume notice into the turn text (see stream.ts). The
        // non-stream path has no onDelta, so the notice reaches the user + the
        // next turn only via llmText → assistantText → history.
        llmText += `\n${buildIncompleteTurnNotice(filesWritten, input.projectRoot, maxLoops)}`;
        void EventBus.getInstance().publish("system:warning", {
          message: `Chat turn hit max loop limit (${maxLoops}). ${filesWritten.size > 0 ? `Modified ${filesWritten.size} file(s); send "continue" to resume.` : "Response may be incomplete."}`,
        });
      } else {
        void EventBus.getInstance().publish("system:warning", {
          message: `Chat turn hit max loop limit (${maxLoops}). Response may be incomplete.`,
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
        modelSpec: getModelSpec(modelName, providerId),
      },
    };
  } catch (err: any) {
    if (terminalStatus === "succeeded") {
      terminalStatus = "failed";
      terminalSummary = err.message || String(err);
    }
    throw err;
  } finally {
    recorder.finishRun(terminalStatus, terminalSummary);
  }
}
