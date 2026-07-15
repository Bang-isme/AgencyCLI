import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import {
  checkCircuitBreaker,
  checkSemanticLoop,
  type CircuitBreakerState,
} from "./circuit-breaker.js";
import { handleLoopMitigation } from "./loop-mitigation.js";
import {
  emitToolFinished,
  emitToolStarted,
  toolResultIsFailure,
} from "./tool-events.js";
import { EventBus } from "../events/event-bus.js";
import { safeAddEpisode } from "./memory-integration.js";
import { isSynthesisBlockedTool } from "./delegation-cycle.js";
import { parseDispatchParallelTasks, type ParallelTaskInput } from "../skill/dispatch-parallel-args.js";

export interface TurnToolCall {
  name: string;
  arguments: Record<string, string>;
}

/**
 * A concise, human-meaningful summary of a tool result for activity rendering.
 * Kept outside stream.ts so streaming, non-streaming, TUI history and tests share
 * one tool-result contract instead of drifting regex copies.
 */
import { registry } from "../skill/tool-harness.js";

export function summarizeToolResult(name: string, result: string, args: Record<string, string> = {}): string {
  let tool = registry.get(name);
  if (!tool && name === "view_file") {
    tool = registry.get("read_file");
  }
  if (tool?.metadata?.resultSummarizer) {
    try {
      return tool.metadata.resultSummarizer(args, result);
    } catch {
      // fallback
    }
  }
  const r = result ?? "";
  const n = r.length;
  return n >= 1024 * 1024 ? `${(n / (1024 * 1024)).toFixed(1)} MB`
    : n >= 1024 ? `${(n / 1024).toFixed(1)} KB`
    : `${n} B`;
}

export function buildToolStepLabel(
  tc: TurnToolCall,
  projectRoot: string
): string {
  let stepLabel = `${tc.name}: ${tc.arguments.path || tc.arguments.AbsolutePath || tc.arguments.command || ""}`;
  if (tc.name !== "read_file" && tc.name !== "view_file") {
    return stepLabel;
  }

  const start = tc.arguments.StartLine || tc.arguments.start_line || tc.arguments.start;
  const end = tc.arguments.EndLine || tc.arguments.end_line || tc.arguments.end;
  if (start !== undefined && end !== undefined) {
    return `${stepLabel} (lines ${start}-${end})`;
  }
  if (start !== undefined) {
    return `${stepLabel} (from line ${start})`;
  }

  const pathArg = tc.arguments.path || tc.arguments.AbsolutePath || "";
  const filePath = resolve(projectRoot, pathArg);
  if (!existsSync(filePath)) {
    return `${stepLabel} (full file)`;
  }

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
  return stepLabel;
}

export interface ExecuteTurnToolBatchOptions {
  toolCalls: TurnToolCall[];
  projectRoot: string;
  skillsRoot: string;
  runId?: string;
  sessionId: string;
  prompt: string;
  loopCount: number;
  modelName?: string;
  signal?: AbortSignal;
  breaker?: CircuitBreakerState | null;
  toolEventAgentId?: string;
  subagentProgressAgentId?: string;
  isFileWritingTool: (name: string) => boolean;
  executeTool: (
    name: string,
    args: Record<string, string>,
    projectRoot: string,
    skillsRoot?: string,
    signal?: AbortSignal,
    breaker?: CircuitBreakerState,
    circuitPrechecked?: boolean,
    sessionId?: string
  ) => Promise<string>;
  truncateToolResult: (name: string, result: string, modelName?: string) => string;
  nextToolEventSeq?: () => number;
  onToolStartedText?: (toolCall: TurnToolCall) => void;
  onToolFinishedText?: (toolCall: TurnToolCall, result: string) => void;
  onFilesWritten?: (path: string) => void;
  recordTool?: (name: string, args: Record<string, string>, result: string) => void;
  executeDispatchSubagentFanout?: (
    calls: TurnToolCall[],
    projectRoot: string,
    skillsRoot?: string,
    signal?: AbortSignal
  ) => Promise<string[]>;
  executeDispatchParallel?: (
    batchLabel: string | undefined,
    tasks: ParallelTaskInput[],
    projectRoot: string,
    skillsRoot?: string,
    signal?: AbortSignal,
    sessionId?: string
  ) => Promise<string>;
  /** When true, only read-only tools are allowed (forced synthesis turn). */
  synthesisMode?: boolean;
}

function makeDispatchId(agentId: string, sessionId: string, index: number): string {
  const safeAgent = (agentId || "subagent").replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "subagent";
  return `${safeAgent}-${sessionId}-${Date.now()}-${index}`;
}

export async function executeTurnToolBatch(
  options: ExecuteTurnToolBatchOptions
): Promise<string> {
  const {
    toolCalls,
    projectRoot,
    skillsRoot,
    sessionId,
    prompt,
    loopCount,
    modelName,
    signal,
    breaker,
    toolEventAgentId = "main",
    subagentProgressAgentId,
    isFileWritingTool,
    executeTool,
    truncateToolResult,
    nextToolEventSeq = () => 0,
    synthesisMode = false,
  } = options;

  const hasParallel = toolCalls.some((tc) => tc.name === "dispatch_parallel");

  if (hasParallel && toolCalls.some((tc) => tc.name !== "dispatch_parallel")) {
    const msg =
      "Error: dispatch_parallel must run alone in this turn — do not mix it with other tools or dispatch_subagent. Plan the batch, call dispatch_parallel once, then continue after the synthesis report.";
    return toolCalls
      .map((tc) => `\n[Tool Result for "${tc.name}":]\n${msg}\n`)
      .join("");
  }

  if (breaker) {
    const batchCheck = checkCircuitBreaker(breaker, toolCalls);
    if (batchCheck.shouldBreak) {
      breaker.trippedReason = batchCheck.reason ?? "Possible infinite loop detected.";
      for (const tc of toolCalls) {
        const toolCallId = String(tc.arguments.callId || tc.arguments.toolCallId || `${tc.name}-${randomUUID()}`);
        emitToolStarted({
          name: tc.name,
          toolArgs: tc.arguments,
          seq: nextToolEventSeq(),
          runId: options.runId,
          turnId: sessionId,
          toolCallId,
          agentId: toolEventAgentId,
        });
        options.onToolStartedText?.(tc);
        emitToolFinished({
          name: tc.name,
          toolArgs: tc.arguments,
          seq: nextToolEventSeq(),
          runId: options.runId,
          turnId: sessionId,
          toolCallId,
          agentId: toolEventAgentId,
          ok: false,
          summary: "blocked by circuit breaker",
          durationMs: 0,
        });
        options.onToolFinishedText?.(tc, `Error: Circuit breaker triggered - ${breaker.trippedReason}`);
      }
      return toolCalls
        .map((tc) => `\n[Tool Result for "${tc.name}":]\nError: Circuit breaker triggered - ${breaker.trippedReason}\n`)
        .join("");
    }
  }

  let dispatchOrdinal = 0;
  for (const tc of toolCalls) {
    if ((tc.name === "dispatch_subagent" || tc.name === "dispatch_parallel") && !tc.arguments.batchId) {
      tc.arguments.batchId = `batch-${sessionId}-${randomUUID()}`;
    }
    if (tc.name === "dispatch_subagent" && !tc.arguments.dispatchId) {
      tc.arguments.dispatchId = makeDispatchId(tc.arguments.agentId || "subagent", sessionId, dispatchOrdinal++);
    }
    if (tc.name === "dispatch_parallel") {
      const parsed = parseDispatchParallelTasks(tc.arguments);
      if (parsed.ok) {
        parsed.tasks.forEach((t) => {
          if (!t.dispatchId) {
            t.dispatchId = makeDispatchId(String(t.agentId || "subagent"), sessionId, dispatchOrdinal++);
          }
        });
        tc.arguments.tasks = JSON.stringify(parsed.tasks);
      }
    }
    if (isFileWritingTool(tc.name) && tc.arguments.path) {
      options.onFilesWritten?.(tc.arguments.path);
    }
  }

  const dispatchCalls = toolCalls.filter((tc) => tc.name === "dispatch_subagent");
  const fanoutResultsPromise =
    dispatchCalls.length > 0 && options.executeDispatchSubagentFanout
      ? options.executeDispatchSubagentFanout(
          dispatchCalls,
          projectRoot,
          skillsRoot,
          signal
        )
      : undefined;

  const fanoutIndexByCall = new Map<TurnToolCall, number>();
  dispatchCalls.forEach((tc, index) => fanoutIndexByCall.set(tc, index));

  const parallelCall = toolCalls.find((tc) => tc.name === "dispatch_parallel");

  const results = await Promise.all(
    toolCalls.map(async (tc) => {
      if (synthesisMode && isSynthesisBlockedTool(tc.name)) {
        const blocked = `Error: Tool "${tc.name}" is blocked during synthesis. Summarize the batch report for the user without re-dispatching.`;
        options.onToolFinishedText?.(tc, blocked);
        return `\n[Tool Result for "${tc.name}":]\n${blocked}\n`;
      }

      const stepLabel = buildToolStepLabel(tc, projectRoot);
      if (subagentProgressAgentId) {
        await EventBus.getInstance().publish("subagent:progress", {
          agentId: subagentProgressAgentId,
          phase: `Running: ${tc.name}`,
          step: { label: stepLabel, status: "active" },
        });
      }

      const toolCallId = String(tc.arguments.callId || tc.arguments.toolCallId || `${tc.name}-${randomUUID()}`);
      emitToolStarted({
        name: tc.name,
        toolArgs: tc.arguments,
        seq: nextToolEventSeq(),
        runId: options.runId,
        turnId: sessionId,
        toolCallId,
        agentId: toolEventAgentId,
      });
      options.onToolStartedText?.(tc);

      const toolStartedAt = Date.now();
      let result: string;

      if (parallelCall && tc === parallelCall && options.executeDispatchParallel) {
        const parsed = parseDispatchParallelTasks(tc.arguments);
        if (!parsed.ok) {
          result = parsed.error;
        } else {
          result = await options.executeDispatchParallel(
            parsed.batchLabel,
            parsed.tasks,
            projectRoot,
            skillsRoot,
            signal,
            sessionId
          );
        }
      } else if (fanoutResultsPromise && tc.name === "dispatch_subagent") {
        result = (await fanoutResultsPromise)[fanoutIndexByCall.get(tc)!] ?? "Error executing subagent dispatch: Missing fan-out result";
      } else {
        result = await executeTool(
          tc.name,
          tc.arguments,
          projectRoot,
          skillsRoot,
          signal,
          breaker ?? undefined,
          Boolean(breaker),
          sessionId
        );
      }

      const truncated = truncateToolResult(tc.name, result, modelName);
      const ok = !toolResultIsFailure(result);
      let summary = "";
      const tool = registry.get(tc.name) || (tc.name === "view_file" ? registry.get("read_file") : undefined);
      if (tool?.metadata?.resultSummarizer) {
        try {
          summary = tool.metadata.resultSummarizer(tc.arguments, result);
        } catch {
          // fallback
        }
      }
      if (!summary) {
        summary = summarizeToolResult(tc.name, result, tc.arguments);
      }

      emitToolFinished({
        name: tc.name,
        toolArgs: tc.arguments,
        seq: nextToolEventSeq(),
        runId: options.runId,
        turnId: sessionId,
        toolCallId,
        agentId: toolEventAgentId,
        ok,
        summary,
        durationMs: Date.now() - toolStartedAt,
      });

      options.recordTool?.(tc.name, tc.arguments, truncated);
      safeAddEpisode(
        projectRoot,
        sessionId,
        prompt,
        loopCount,
        `tool_call:${tc.name}`,
        `Arguments: ${JSON.stringify(tc.arguments)}\nResult:\n${truncated}`
      );

      if (subagentProgressAgentId) {
        await EventBus.getInstance().publish("subagent:progress", {
          agentId: subagentProgressAgentId,
          phase: `Completed: ${tc.name}`,
          step: { label: stepLabel, status: "done" },
        });
      }

      options.onToolFinishedText?.(tc, result);
      return `\n[Tool Result for "${tc.name}":]\n${truncated}\n`;
    })
  );

  return results.join("");
}

export interface ApplyLoopMitigationOptions {
  breaker: CircuitBreakerState | null;
  toolCalls: TurnToolCall[];
  turnHistory: { role: string; content: string }[];
  agentId?: string;
  conversationId: string;
  projectRoot: string;
  waitForResume?: boolean;
  onPause?: () => void;
  onResume?: () => void;
}

export async function applyLoopMitigation(
  options: ApplyLoopMitigationOptions
): Promise<void> {
  const { breaker } = options;
  if (!breaker) return;

  const isSemanticLoop = checkSemanticLoop(breaker, options.toolCalls);
  if (!isSemanticLoop && breaker.consecutiveFailures < 3) return;

  if (breaker.consecutiveFailures >= 5 && options.waitForResume) {
    options.onPause?.();
  }

  const mitigation = await handleLoopMitigation(
    breaker,
    options.turnHistory,
    {
      agentId: options.agentId,
      conversationId: options.conversationId,
      projectRoot: options.projectRoot,
      waitForResume: options.waitForResume,
    }
  );

  if (mitigation.action === "abort") {
    breaker.trippedReason = mitigation.feedback || "Execution aborted by Loop Mitigation.";
  } else if (mitigation.feedback) {
    options.onResume?.();
    options.turnHistory.push({
      role: "system",
      content: `[USER STEERING INSTRUCTION] ${mitigation.feedback}`,
    });
  }
}
