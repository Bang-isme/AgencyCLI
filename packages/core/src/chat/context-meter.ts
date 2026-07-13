import { estimateMessagesTokens, getBaselineModelSpec, type ChatMessage } from "@agency/providers";
import type { RouteResult } from "../router/model-router.js";
import { buildSystemPrompt } from "./prompt.js";

/** Match {@link estimateMessagesTokens} — conservative chars/token ratio. */
const CHARS_PER_TOKEN = 3.5;

export type ContextSegmentId =
  | "systemPrompt"
  | "toolDefinitions"
  | "rules"
  | "skills"
  | "subagentDefinitions"
  | "summarizedConversation"
  | "conversation"
  | "inflightResponse";

export interface ContextSegment {
  id: ContextSegmentId;
  label: string;
  tokens: number;
}

export interface ContextBreakdown {
  segments: ContextSegment[];
  /** Sum of all segments — estimated turn payload sent to the provider. */
  totalTokens: number;
  /** Catalog baseline context window (ignores stale overrides). */
  contextWindow: number;
  percent: number;
  /** Session messages only (legacy meter) for comparison. */
  sessionOnlyTokens: number;
  /** True when built from live turnHistory rather than session estimate. */
  fromTurnPayload?: boolean;
  /** True when the estimate includes assistant text still being streamed. */
  includesInflight?: boolean;
}

export function estimateTextTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

export interface DecomposedSystemPrompt {
  systemPrompt: string;
  rules: string;
  subagentDefinitions: string;
  toolDefinitions: string;
  skills: string;
}

/** Split a built system prompt into meter segments (OpenCode-style). */
export function decomposeSystemPrompt(full: string): DecomposedSystemPrompt {
  const workingIdx = full.indexOf("### WORKING PROGRESSION");
  const specialistsIdx = full.indexOf("AVAILABLE SPECIALISTS");
  const toolsIdx = full.indexOf("AVAILABLE TOOLS:");
  const contextIdx = full.indexOf("# Context");

  const systemEnd = workingIdx >= 0 ? workingIdx : specialistsIdx >= 0 ? specialistsIdx : full.length;
  const rulesEnd = specialistsIdx >= 0 ? specialistsIdx : toolsIdx >= 0 ? toolsIdx : full.length;
  const specialistsEnd = toolsIdx >= 0 ? toolsIdx : contextIdx >= 0 ? contextIdx : full.length;
  const toolsEnd = contextIdx >= 0 ? contextIdx : full.length;

  return {
    systemPrompt: full.slice(0, systemEnd).trim(),
    rules: workingIdx >= 0 ? full.slice(workingIdx, rulesEnd).trim() : "",
    subagentDefinitions: specialistsIdx >= 0 ? full.slice(specialistsIdx, specialistsEnd).trim() : "",
    toolDefinitions: toolsIdx >= 0 ? full.slice(toolsIdx, toolsEnd).trim() : "",
    skills: contextIdx >= 0 ? full.slice(contextIdx).trim() : "",
  };
}

const SEGMENT_DEFS: Array<{ id: ContextSegmentId; label: string; key: keyof DecomposedSystemPrompt }> = [
  { id: "systemPrompt", label: "System prompt", key: "systemPrompt" },
  { id: "toolDefinitions", label: "Tool definitions", key: "toolDefinitions" },
  { id: "rules", label: "Rules", key: "rules" },
  { id: "skills", label: "Skills & context pack", key: "skills" },
  { id: "subagentDefinitions", label: "Subagent definitions", key: "subagentDefinitions" },
];

function segmentFromDecomposed(parts: DecomposedSystemPrompt): ContextSegment[] {
  return SEGMENT_DEFS.map(({ id, label, key }) => ({
    id,
    label,
    tokens: estimateTextTokens(parts[key]),
  })).filter((s) => s.tokens > 0);
}

function classifyHistoryMessages(messages: ChatMessage[]): {
  summarized: ChatMessage[];
  conversation: ChatMessage[];
} {
  const summarized: ChatMessage[] = [];
  const conversation: ChatMessage[] = [];
  for (const msg of messages) {
    const content = typeof msg.content === "string" ? msg.content : "";
    if (
      msg.role === "system" &&
      (content.includes("[CONVERSATION SUMMARY]") || content.includes("earlier turn(s) omitted"))
    ) {
      summarized.push(msg);
    } else if (msg.role !== "system") {
      conversation.push(msg);
    }
  }
  return { summarized, conversation };
}

export interface EstimateContextBreakdownInput {
  model?: string;
  providerId?: string;
  /** Full turn history as sent to the provider (most accurate). */
  turnMessages?: ChatMessage[];
  /** Visible session transcript (TUI). */
  sessionMessages?: Array<{ role?: string; content: string }>;
  /** Build system prompt estimate when turnMessages omitted. */
  route?: RouteResult;
  userPrompt?: string;
  contextPack?: string;
  projectRoot?: string;
  historicalMemories?: string;
  /** Assistant text currently streaming (not yet committed to turnHistory). */
  inflightAssistantText?: string;
  /** Reasoning/thought text currently streaming. */
  inflightThoughtText?: string;
}

/** Add in-flight streaming tokens to an existing breakdown (replaces prior inflight segment). */
export function mergeInflightContext(
  breakdown: ContextBreakdown,
  inflightAssistantText?: string,
  inflightThoughtText?: string
): ContextBreakdown {
  const inflightTokens =
    estimateTextTokens(inflightAssistantText ?? "") + estimateTextTokens(inflightThoughtText ?? "");
  if (inflightTokens === 0) return breakdown;

  const segments = breakdown.segments.filter((s) => s.id !== "inflightResponse");
  segments.push({
    id: "inflightResponse",
    label: "In-flight response (streaming)",
    tokens: inflightTokens,
  });

  const totalTokens = segments.reduce((sum, s) => sum + s.tokens, 0);
  const percent =
    breakdown.contextWindow > 0
      ? Math.min(100, Math.round((totalTokens / breakdown.contextWindow) * 100))
      : 0;

  return {
    ...breakdown,
    segments,
    totalTokens,
    percent,
    includesInflight: true,
    fromTurnPayload: breakdown.fromTurnPayload ?? true,
  };
}

export function estimateContextBreakdown(input: EstimateContextBreakdownInput): ContextBreakdown {
  const bareModel = input.model?.split("/").slice(-1)[0] ?? input.model ?? "";
  const providerId = input.providerId ?? input.model?.split("/")[0];
  const contextWindow = getBaselineModelSpec(bareModel, providerId).contextWindow;

  const sessionOnlyTokens = input.sessionMessages?.length
    ? estimateMessagesTokens(
        input.sessionMessages.map((m) => ({
          role: (m.role === "assistant" || m.role === "system" ? m.role : "user") as ChatMessage["role"],
          content: m.content ?? "",
        }))
      )
    : 0;

  const segments: ContextSegment[] = [];
  let fromTurnPayload = false;

  if (input.turnMessages && input.turnMessages.length > 0) {
    fromTurnPayload = true;
    const systemMsg = input.turnMessages.find((m) => m.role === "system");
    const systemContent = typeof systemMsg?.content === "string" ? systemMsg.content : "";
    segments.push(...segmentFromDecomposed(decomposeSystemPrompt(systemContent)));

    const rest = input.turnMessages.filter((m) => m !== systemMsg);
    const { summarized, conversation } = classifyHistoryMessages(rest);
    if (summarized.length > 0) {
      segments.push({
        id: "summarizedConversation",
        label: "Summarized conversation",
        tokens: estimateMessagesTokens(summarized),
      });
    }
    if (conversation.length > 0) {
      segments.push({
        id: "conversation",
        label: "Conversation",
        tokens: estimateMessagesTokens(conversation),
      });
    }
  } else {
    const route: RouteResult = input.route ?? {
      intent: "general",
      suggested_agent: null,
      workflow: "general",
      skills: [],
      provider: providerId ?? "openrouter",
      warnings: [],
    };
    const userPrompt = input.userPrompt ?? "";
    const systemFull = buildSystemPrompt(
      route,
      userPrompt,
      input.contextPack ?? "",
      input.projectRoot ?? process.cwd(),
      undefined,
      undefined,
      input.historicalMemories
    );
    segments.push(...segmentFromDecomposed(decomposeSystemPrompt(systemFull)));

    const sessionChat: ChatMessage[] = (input.sessionMessages ?? []).map((m) => ({
      role: (m.role === "assistant" || m.role === "system" ? m.role : "user") as ChatMessage["role"],
      content: m.content ?? "",
    }));
    const { summarized, conversation } = classifyHistoryMessages(sessionChat);
    if (summarized.length > 0) {
      segments.push({
        id: "summarizedConversation",
        label: "Summarized conversation",
        tokens: estimateMessagesTokens(summarized),
      });
    }
    if (conversation.length > 0) {
      segments.push({
        id: "conversation",
        label: "Conversation",
        tokens: estimateMessagesTokens(conversation),
      });
    }
  }

  const totalTokens = segments.reduce((sum, s) => sum + s.tokens, 0);
  const percent = contextWindow > 0 ? Math.min(100, Math.round((totalTokens / contextWindow) * 100)) : 0;

  const base: ContextBreakdown = {
    segments,
    totalTokens,
    contextWindow,
    percent,
    sessionOnlyTokens,
    fromTurnPayload,
  };

  if (input.inflightAssistantText || input.inflightThoughtText) {
    return mergeInflightContext(base, input.inflightAssistantText, input.inflightThoughtText);
  }

  return base;
}
