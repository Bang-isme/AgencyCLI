export type BudgetMode = "tight" | "normal" | "deep";

export interface TokenBudgetPlan {
  mode: BudgetMode;
  /** Max file paths injected into LLM context. */
  maxContextFiles: number;
  /** Max characters for structured context block. */
  maxContextChars: number;
  /** Suggested max tokens for LLM completion. */
  maxLlmOutputTokens: number;
  /** Whether workflow steps may include runtime_hook preflight. */
  allowPreflight: boolean;
  /** Include full route JSON in route-only chat output. */
  includeFullRouteJson: boolean;
  /** Use session route cache when prompt unchanged. */
  useRouteCache: boolean;
}

const PLANS: Record<BudgetMode, TokenBudgetPlan> = {
  tight: {
    mode: "tight",
    maxContextFiles: 0,
    maxContextChars: 1500,
    maxLlmOutputTokens: 1024,
    allowPreflight: false,
    includeFullRouteJson: false,
    useRouteCache: true,
  },
  normal: {
    mode: "normal",
    maxContextFiles: 12,
    maxContextChars: 32000,
    maxLlmOutputTokens: 2048,
    allowPreflight: false,
    includeFullRouteJson: false,
    useRouteCache: true,
  },
  deep: {
    mode: "deep",
    maxContextFiles: 25,
    maxContextChars: 64000,
    maxLlmOutputTokens: 4096,
    allowPreflight: true,
    includeFullRouteJson: false,
    useRouteCache: true,
  },
};

import { getModelSpec } from "@agency/providers";

export function getTokenBudgetPlan(mode: BudgetMode = "normal", modelName?: string): TokenBudgetPlan {
  const plan = { ...PLANS[mode] };
  if (!modelName) return plan;

  try {
    const spec = getModelSpec(modelName);
    if (spec && spec.contextWindow) {
      // Safety Margin of 10% for context window (A1)
      const maxOutputLimit = spec.maxOutputTokens;
      const safetyMarginTokens = spec.contextWindow * 0.10;
      const maxContextTokens = Math.max(1000, spec.contextWindow - safetyMarginTokens - maxOutputLimit);

      // Convert tokens to characters (~4 characters per token in code/text)
      const adaptiveMaxChars = Math.round(maxContextTokens * 4);

      if (mode === "tight") {
        plan.maxContextChars = Math.min(1500, adaptiveMaxChars);
        plan.maxContextFiles = 0;
        plan.maxLlmOutputTokens = Math.min(1024, maxOutputLimit);
      } else if (mode === "normal") {
        plan.maxContextChars = Math.min(128000, Math.max(16000, adaptiveMaxChars));
        plan.maxContextFiles = spec.contextWindow >= 100000 ? 30 : 12;
        plan.maxLlmOutputTokens = Math.min(2048, maxOutputLimit);
      } else if (mode === "deep") {
        plan.maxContextChars = Math.min(512000, Math.max(32000, adaptiveMaxChars));
        plan.maxContextFiles = spec.contextWindow >= 100000 ? 60 : 25;
        plan.maxLlmOutputTokens = Math.min(4096, maxOutputLimit);
      }
    }
  } catch {
    // safe fallback
  }

  return plan;
}

export function parseBudgetMode(value: string | undefined): BudgetMode {
  if (value === "tight" || value === "normal" || value === "deep") return value;
  return "normal";
}
