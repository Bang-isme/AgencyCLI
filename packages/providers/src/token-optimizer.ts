// ---------------------------------------------------------------------------
// Anti-Flop Token Optimizer
//
// Adjusts thinking budget and output tokens based on task intent.
// Prevents wasting tokens on simple searches while ensuring deep
// reasoning gets enough budget. Tracks output quality to detect flops.
// ---------------------------------------------------------------------------

import type { ModelSpec } from "./thinking-spec.js";

export type TaskIntent =
  | "search"
  | "tool_call"
  | "reasoning"
  | "generation"
  | "chat";

export interface TokenOptimization {
  /** Adjusted max output tokens for this task. */
  maxOutputTokens: number;
  /** Adjusted thinking budget (null = no override). */
  thinkingBudget: number | null;
  /** Adjusted temperature (null = no override). */
  temperature: number | null;
  /** Human-readable reason for the optimization. */
  reason: string;
}

/**
 * Multiplier table: [outputFraction, thinkingFraction, temperature].
 * Fractions are relative to model's maxOutputTokens.
 */
const INTENT_PROFILES: Record<TaskIntent, [number, number, number | null]> = {
  search:     [0.30, 0.05, 0.2],    // Minimal thinking, short output, low temp
  tool_call:  [0.25, 0.10, 0.1],    // Precise, minimal, deterministic
  reasoning:  [0.80, 0.50, null],   // Full thinking, large output
  generation: [1.00, 0.15, null],   // Max output, moderate thinking
  chat:       [0.50, 0.25, null],   // Balanced
};

const INTENT_REASONS: Record<TaskIntent, string> = {
  search:     "Optimized for search: reduced thinking, fast response",
  tool_call:  "Optimized for tool calls: precise, token efficient",
  reasoning:  "Optimized for reasoning: maximum thinking budget",
  generation: "Optimized for generation: maximum output, moderate thinking",
  chat:       "Balanced mode for chat",
};

/**
 * Compute optimized token settings for a given task type.
 *
 * If the user has manually set a thinking value via /variant,
 * `currentThinking` is passed in and used as a ceiling — the optimizer
 * won't exceed it but may reduce it for lightweight tasks.
 */
export function optimizeForTask(
  intent: TaskIntent,
  spec: ModelSpec,
  currentThinking?: number | string,
): TokenOptimization {
  if (process.env.DISABLE_TOKEN_OPTIMIZER === "true") {
    let thinkingBudget: number | null = null;
    if (spec.thinkingType === "budget") {
      if (currentThinking !== undefined && currentThinking !== "off") {
        const userBudget = typeof currentThinking === "number"
          ? currentThinking
          : parseInt(String(currentThinking), 10);
        if (!isNaN(userBudget) && userBudget > 0) {
          thinkingBudget = userBudget;
        }
      }
    }
    return {
      maxOutputTokens: spec.maxOutputTokens,
      thinkingBudget,
      temperature: null,
      reason: "Token optimization bypassed (DISABLE_TOKEN_OPTIMIZER=true)",
    };
  }

  const [outputFrac, thinkingFrac, temp] = INTENT_PROFILES[intent]!;

  const maxOutput = Math.round(spec.maxOutputTokens * outputFrac);

  let thinkingBudget: number | null = null;

  if (spec.thinkingType === "budget") {
    const idealBudget = Math.round(spec.maxOutputTokens * thinkingFrac);

    if (currentThinking !== undefined && currentThinking !== "off") {
      const userBudget = typeof currentThinking === "number"
        ? currentThinking
        : parseInt(String(currentThinking), 10);

      if (!isNaN(userBudget) && userBudget > 0) {
        // Don't exceed user's configured ceiling, but may reduce for light tasks
        thinkingBudget = Math.min(userBudget, idealBudget);
      } else {
        thinkingBudget = idealBudget;
      }
    } else {
      thinkingBudget = idealBudget;
    }
  }
  // effort-based models: no token budget optimization, handled by API natively

  return {
    maxOutputTokens: maxOutput,
    thinkingBudget,
    temperature: temp,
    reason: INTENT_REASONS[intent]!,
  };
}

// ---- Anti-Flop Detection ----------------------------------------------------

export interface OutputQualitySignals {
  outputTokens: number;
  inputTokens: number;
  wasEmpty: boolean;
  wasError: boolean;
  responseTimeMs: number;
}

export interface FlopAnalysis {
  isFlop: boolean;
  severity: "none" | "minor" | "major";
  suggestion: string;
}

/**
 * Analyze an LLM response for flop signals.
 *
 * A "flop" is when the model returns:
 * - Empty or near-empty output
 * - Output much shorter than expected given the input
 * - Repeated errors
 */
export function detectFlop(
  signals: OutputQualitySignals,
  spec: ModelSpec,
): FlopAnalysis {
  if (signals.wasError) {
    return {
      isFlop: true,
      severity: "major",
      suggestion: "API error occurred. Try increasing variant level or check your API key.",
    };
  }

  if (signals.wasEmpty) {
    return {
      isFlop: true,
      severity: "major",
      suggestion: "Model returned empty output. Try '/variant high' or switch models.",
    };
  }

  // Output ratio: output tokens vs expected minimum
  const expectedMin = Math.min(50, spec.maxOutputTokens * 0.01);
  if (signals.outputTokens < expectedMin && signals.inputTokens > 100) {
    return {
      isFlop: true,
      severity: "minor",
      suggestion: `Output too short (${signals.outputTokens} tokens). Try increasing thinking variant.`,
    };
  }

  // Extremely slow response might indicate overloaded free tier
  if (signals.responseTimeMs > 60_000 && signals.outputTokens < 200) {
    return {
      isFlop: false,
      severity: "minor",
      suggestion: "Slow response — potential rate limits. Consider '/variant low' to optimize.",
    };
  }

  return { isFlop: false, severity: "none", suggestion: "" };
}

/**
 * Infer task intent from a user prompt.
 * Simple heuristic — good enough for optimization hints.
 */
export function inferTaskIntent(prompt: string): TaskIntent {
  const lower = prompt.toLowerCase();

  // 1. Highly complex analysis / bug-fixing / design / refactoring (50% budget)
  // Check this FIRST to ensure debugging/fixing is not overridden by lightweight keywords (like "test")
  if (
    lower.includes("explain") || lower.includes("why") || lower.includes("analyze") ||
    lower.includes("debug") || lower.includes("fix") || lower.includes("giải thích") ||
    lower.includes("phân tích") || lower.includes("refactor") || lower.includes("implement") ||
    lower.includes("architect") || lower.includes("optimize") || lower.includes("tối ưu") ||
    lower.includes("sửa lỗi") || lower.includes("thiết kế") || lower.includes("xây dựng") ||
    lower.includes("solve") || lower.includes("resolve")
  ) {
    return "reasoning";
  }

  // 2. Lightweight / documentation / comments / styling tasks (5-10% budget)
  if (
    lower.includes("comment") || lower.includes("documentation") || lower.includes("readme") ||
    lower.includes("typo") || lower.includes("formatting") || lower.includes("style") ||
    lower.includes("chú thích") || lower.includes("tài liệu") || lower.includes("hướng dẫn")
  ) {
    return "search"; // Maps to 5% thinking budget, extremely fast and cheap
  }

  // 3. Search / Query / Informational tasks
  if (lower.includes("search") || lower.includes("find") || lower.includes("look up") || lower.includes("tìm") || lower.includes("show")) {
    return "search";
  }

  // 4. Local developer tasks (testing, linting, formatting, compiling, benchmarking)
  if (
    lower.includes("test") || lower.includes("lint") || lower.includes("prettier") ||
    lower.includes("format") || lower.includes("build") || lower.includes("compile") ||
    lower.includes("benchmark") || lower.includes("dịch") || lower.includes("chạy thử")
  ) {
    return "tool_call";
  }

  // 5. Execution / Command run / Tool invocation tasks
  if (lower.includes("run") || lower.includes("execute") || lower.includes("call") || lower.includes("invoke") || lower.includes("chạy")) {
    return "tool_call";
  }

  // 6. Code generation / New file creation
  if (
    lower.includes("write") || lower.includes("generate") || lower.includes("create") ||
    lower.includes("viết") || lower.includes("tạo")
  ) {
    return "generation";
  }

  return "chat";
}
