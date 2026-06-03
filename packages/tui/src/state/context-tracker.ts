/**
 * Estimate context window usage for the current session.
 *
 * Rough heuristic: ~4 chars per token for English text.
 * Real tokenizers vary, but this gives a useful gauge for the status bar.
 */

const CHARS_PER_TOKEN = 4;

const DEFAULT_CONTEXT_WINDOW = 128_000;

const LOCAL_CONTEXT_WINDOWS: Record<string, number> = {
  "meta/llama-3.1-70b-instruct": 128_000,
};

import { getRegisteredContextWindow } from "@agency/providers";

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
  /** Estimated token count */
  estimatedTokens: number;
  /** Model's context window size in tokens */
  contextWindow: number;
  /** Usage percentage (0-100) */
  percent: number;
}

export function estimateContextUsage(
  messages: Array<{ content: string }>,
  model?: string
): ContextUsage {
  const totalChars = messages.reduce((sum, m) => sum + (m.content?.length ?? 0), 0);
  const estimatedTokens = Math.ceil(totalChars / CHARS_PER_TOKEN);
  const contextWindow = getModelContextWindow(model);
  // Guard against a 0/undefined context window (unknown model) → never NaN%.
  const percent = contextWindow > 0
    ? Math.min(100, Math.round((estimatedTokens / contextWindow) * 100))
    : 0;

  return { totalChars, estimatedTokens, contextWindow, percent };
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
