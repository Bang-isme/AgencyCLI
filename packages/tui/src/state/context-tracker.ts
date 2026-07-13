/**
 * Estimate context window usage for the current session.
 *
 * Rough heuristic: ~4 chars per token for English text.
 * Real tokenizers vary, but this gives a useful gauge for the status bar.
 */

import { getRegisteredContextWindow } from "@agency/providers";
import {
  estimateContextBreakdown,
  mergeInflightContext,
  type ContextBreakdown,
} from "@agency/core";

const DEFAULT_CONTEXT_WINDOW = 128_000;

const LOCAL_CONTEXT_WINDOWS: Record<string, number> = {
  "meta/llama-3.1-70b-instruct": 128_000,
};

function getProviderContextWindow(model: string): number | null {
  try {
    return getRegisteredContextWindow(model);
  } catch {
    return null;
  }
}

export function getModelContextWindow(model?: string): number {
  if (!model) return DEFAULT_CONTEXT_WINDOW;

  // 1. Try providers registry (single source of truth)
  const fromRegistry = getProviderContextWindow(model);
  if (fromRegistry !== null) return fromRegistry;

  // 2. Local fallback
  if (LOCAL_CONTEXT_WINDOWS[model]) return LOCAL_CONTEXT_WINDOWS[model]!;
  const base = model.split("/").pop() ?? model;
  if (LOCAL_CONTEXT_WINDOWS[base]) return LOCAL_CONTEXT_WINDOWS[base]!;

  // 3. Partial match
  for (const [key, value] of Object.entries(LOCAL_CONTEXT_WINDOWS)) {
    if (model.includes(key) || key.includes(model)) return value;
  }

  return DEFAULT_CONTEXT_WINDOW;
}

export interface ContextUsage {
  /** Total characters across all session messages */
  totalChars: number;
  /** Estimated token count (full turn payload) */
  estimatedTokens: number;
  /** Session transcript only (excludes system prompt / tools) */
  sessionOnlyTokens: number;
  /** Model's context window size in tokens (catalog) */
  contextWindow: number;
  /** Usage percentage (0-100) against catalog window */
  percent: number;
  /** Detailed segment breakdown */
  breakdown: ContextBreakdown;
}

export type { ContextBreakdown };

export interface EstimateContextOptions {
  projectRoot?: string;
  userPrompt?: string;
  contextPack?: string;
  providerId?: string;
  liveBreakdown?: ContextBreakdown | null;
  /** Local streaming buffer — merged when fresher than the last EventBus meter. */
  inflightAssistantText?: string;
  inflightThoughtText?: string;
}

export function estimateContextUsage(
  messages: Array<{ role?: string; content: string }>,
  model?: string,
  options: EstimateContextOptions = {}
): ContextUsage {
  const parts = model?.split("/") ?? [];
  const providerId = options.providerId ?? (parts.length > 1 ? parts[0] : undefined);
  const bareModel = parts.length > 1 ? parts.slice(1).join("/") : model;

  let breakdown =
    options.liveBreakdown ??
    estimateContextBreakdown({
      model: bareModel,
      providerId,
      sessionMessages: messages,
      userPrompt: options.userPrompt,
      contextPack: options.contextPack,
      projectRoot: options.projectRoot,
    });

  if (options.inflightAssistantText || options.inflightThoughtText) {
    breakdown = mergeInflightContext(
      breakdown,
      options.inflightAssistantText,
      options.inflightThoughtText
    );
  }

  const totalChars = messages.reduce((sum, m) => sum + (m.content?.length ?? 0), 0);

  return {
    totalChars,
    estimatedTokens: breakdown.totalTokens,
    sessionOnlyTokens: breakdown.sessionOnlyTokens,
    contextWindow: breakdown.contextWindow,
    percent: breakdown.percent,
    breakdown,
  };
}

export type ActivityPhase =
  | "idle"
  | "routing"
  | "exploring"
  | "reading"
  | "analyzing"
  | "thinking"
  | "writing"
  | "editing"
  | "running";

const PHASE_LABELS: Record<ActivityPhase, string> = {
  idle: "",
  routing: "Routing",
  exploring: "Exploring",
  reading: "Reading",
  analyzing: "Analyzing",
  thinking: "Thinking",
  writing: "Writing",
  editing: "Editing",
  running: "Running",
};

export function getPhaseLabel(phase: ActivityPhase): string {
  return PHASE_LABELS[phase] ?? phase;
}
