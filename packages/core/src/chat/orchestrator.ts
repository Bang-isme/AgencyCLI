import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  getProvider,
  loadAgencyConfig,
  getModelSpec,
  updateModelOverride,
  isContextLimitError,
  parseContextLimit,
  estimateMessagesTokens,
  isTransientError,
  type ProviderId,
  type ModelSpec,
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
import { getInvokeActions } from "../skill/invoke-actions.js";
import { globalCostGovernor, globalProviderSupervisor } from "../utils/governance-instance.js";
import { buildSystemPrompt } from "./prompt.js";
import { providerHasKey, resolveRoute, repackContextAndSystemPrompt, compactTurnHistory, recordTurnTokenCost } from "./turn-helpers.js";
import { getRuntimeFlags } from "../runtime/flags.js";
import { parseToolCalls, executeTool, truncateToolResult, isFileWritingTool } from "../skill/tool-harness.js";
import { EventBus } from "../events/event-bus.js";
import { runGateQuick } from "../task/runner.js";
import { loadHistoricalMemories, safeAddEpisode } from "./memory-integration.js";



export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

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
}


export async function runChatTurn(
  input: ChatTurnInput
): Promise<ChatTurnResult> {
  const resolvedSessionId = input.sessionId || process.env.AGENCY_SESSION_ID || "sess-cli";
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

  // Resolve the adaptive token budget plan based on the resolved modelName (A1)
  let plan = getTokenBudgetPlan(budget, modelName);

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

    // §2.3 — proactively compact a long history before it overflows the window.
    if (getRuntimeFlags().contextCompaction) {
      const compaction = await compactTurnHistory(
        turnHistory,
        provider,
        getModelSpec(modelName).contextWindow
      );
      turnHistory = compaction.messages;
    }

    loopCount = 0;
    const maxLoops = input.maxLoops ?? (budget === "deep" ? 15 : budget === "normal" ? 8 : 3);

    while (loopCount < maxLoops) {
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
            }
          );
          completionSuccess = true;
        } catch (err: any) {
          if (isContextLimitError(err) && attempt < maxAttempts) {
            attempt++;
            const currentSpec = getModelSpec(modelName);
            const oldLimit = currentSpec.contextWindow;

            if (oldLimit > 8192) {
              const parsedLimit = parseContextLimit(err.message || String(err));
              let newLimit = parsedLimit;
              if (!newLimit || newLimit >= oldLimit) {
                newLimit = Math.max(8192, Math.floor(oldLimit * 0.8));
              } else {
                newLimit = Math.max(8192, newLimit);
              }

              updateModelOverride(modelName, { contextWindow: newLimit });

              const updatedConfig = loadAgencyConfig();
              provider = getProvider(updatedConfig, providerId);
              const updatedPlan = getTokenBudgetPlan(budget, modelName);
              plan = updatedPlan;

              const newSystemPrompt = repackContextAndSystemPrompt(input, route, updatedPlan, historicalMemories);
              turnHistory[0].content = newSystemPrompt;

              const estimated = estimateMessagesTokens(turnHistory);

              void EventBus.getInstance().publish("system:warning", {
                message: `Context limit exceeded for model ${modelName} (estimated prompt: ${estimated} tokens). Auto-reducing context window limit from ${oldLimit} to ${newLimit} tokens and retrying...`
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

      // Check for XML tool calls
      const toolCalls = parseToolCalls(currentText);
      if (toolCalls.length > 0) {
        for (const tc of toolCalls) {
          if (isFileWritingTool(tc.name) && tc.arguments.path) {
            filesWritten.add(tc.arguments.path);
          }
        }

        const prevFilesWrittenCount = filesWritten.size;
        const results = await Promise.all(
          toolCalls.map(async (tc) => {
            const agentId = input.agentId || process.env.AGENCY_AGENT_ID;
            let stepLabel = `${tc.name}: ${tc.arguments.path || tc.arguments.AbsolutePath || tc.arguments.command || ""}`;
            if (tc.name === "read_file" || tc.name === "view_file") {
              const start = tc.arguments.StartLine || tc.arguments.start_line || tc.arguments.start;
              const end = tc.arguments.EndLine || tc.arguments.end_line || tc.arguments.end;
              if (start !== undefined && end !== undefined) {
                stepLabel += ` (lines ${start}-${end})`;
              } else if (start !== undefined) {
                stepLabel += ` (from line ${start})`;
              } else {
                const pathArg = tc.arguments.path || tc.arguments.AbsolutePath || "";
                const filePath = resolve(input.projectRoot, pathArg);
                if (existsSync(filePath)) {
                  try {
                    const content = readFileSync(filePath, "utf8");
                    const totalLines = content.split("\n").length;
                    const maxDefaultLines = tc.name === "view_file" ? 800 : 500;
                    const defaultReadLines = tc.name === "view_file" ? 800 : 300;
                    if (totalLines <= maxDefaultLines) {
                      stepLabel += ` (lines 1-${totalLines})`;
                    } else {
                      stepLabel += ` (lines 1-${defaultReadLines} of ${totalLines})`;
                    }
                  } catch {
                    stepLabel += ` (full file)`;
                  }
                } else {
                  stepLabel += ` (full file)`;
                }
              }
            }
            if (agentId) {
              const eventBus = EventBus.getInstance();
              await eventBus.publish("subagent:progress", {
                agentId,
                phase: `Running: ${tc.name}`,
                step: { label: stepLabel, status: "active" }
              });
            }
            const result = await executeTool(tc.name, tc.arguments, input.projectRoot, input.skillsRoot);
            const modelName = config.providers[providerId as ProviderId]?.model || (config.providers as any)[providerId]?.defaultModel;
            const truncated = truncateToolResult(tc.name, result, modelName);
            safeAddEpisode(
              input.projectRoot,
              resolvedSessionId,
              input.prompt,
              loopCount,
              `tool_call:${tc.name}`,
              `Arguments: ${JSON.stringify(tc.arguments)}\nResult:\n${truncated}`
            );
            if (agentId) {
              const eventBus = EventBus.getInstance();
              await eventBus.publish("subagent:progress", {
                agentId,
                phase: `Completed: ${tc.name}`,
                step: { label: stepLabel, status: "done" }
              });
            }
            return `\n[Tool Result for "${tc.name}":]\n${truncated}\n`;
          })
        );
        const toolOutputs = results.join("");

        let gateFailureText = "";
        if (filesWritten.size > prevFilesWrittenCount && !input.noVerify) {
          const gateResult = await runGateQuick(input.projectRoot, input.skillsRoot);
          if (gateResult.exitCode !== 0) {
            gateFailureText = `\n\n[SYSTEM WARNING: Post-edit verification (gate-quick) failed with exit code ${gateResult.exitCode}.\nBuild/test output:\n${gateResult.stdout}\n\nPlease self-heal and resolve any compilation or test errors. Modify the code to fix these issues.]\n`;
          }
        }

        turnHistory = [
          ...turnHistory,
          { role: "assistant" as const, content: currentText },
          { role: "user" as const, content: toolOutputs + gateFailureText },
        ];
        loopCount++;
        continue;
      }

      const lowerReason = lastFinishReason.toLowerCase();
      if (lowerReason === "length" || lowerReason === "max_tokens" || lowerReason === "max_token_tokens" || lowerReason === "max_tokens_budget") {
        turnHistory = [
          ...turnHistory,
          { role: "assistant" as const, content: currentText },
          {
            role: "user" as const,
            content: "You were cut off because of token limit limits. Continue exactly where you left off without any preamble, greeting, or repetitive sentences. Maintain the exact formatting structure, including active markdown code blocks or SEARCH/REPLACE blocks without duplication.",
          },
        ];
        loopCount++;
      } else {
        break;
      }
    }

    if (loopCount >= maxLoops) {
      void EventBus.getInstance().publish("system:warning", {
        message: `Chat turn hit max loop limit (${maxLoops}). Response may be incomplete.`,
      });
    }

    const duration = Date.now() - startTime;
    globalProviderSupervisor.recordCall(providerId, duration, true);

    // Record actual or estimated tokens cost (shared estimate — see turn-helpers).
    recordTurnTokenCost(aggregatedUsage, contextPack, llmText, providerId);
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
      modelSpec: getModelSpec(modelName),
    },
  };
}
