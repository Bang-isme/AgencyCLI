// ---------------------------------------------------------------------------
// Model Thinking Spec — Data-Driven Registry
//
// Each model gets its own entry with real output-token limits.
// Variants are computed dynamically as percentages of maxOutputTokens,
// so DeepSeek V4 Pro ≠ DeepSeek R1, Gemini Flash ≠ Gemini Pro, etc.
// ---------------------------------------------------------------------------

import { loadAgencyConfig } from "./config.js";
import {
  matchModelKey,
  getCatalogSpec,
  isModelCatalogEnabled,
  type CatalogCapabilities,
} from "./model-catalog.js";

/** Technical spec for a single model. */
export interface ModelSpec {
  maxOutputTokens: number;
  contextWindow: number;
  thinkingType: "budget" | "effort" | "none";
  /** Only for effort-based models (OpenAI o-series). */
  effortLevels?: string[];
  /** Known free-tier rate limits. */
  freeRateLimit?: { rpm: number; tpm: number };
  specSource?: "override" | "registry" | "api" | "heuristics" | "default" | "catalog";
  /** USD per 1,000,000 tokens, from the model catalog (models.json) when available. */
  cost?: { input: number; output: number };
  /** Model capabilities from the catalog (tool-call, temperature, reasoning, vision). */
  capabilities?: CatalogCapabilities;
}

function getOverrideSpec(model: string): ModelSpec | null {
  try {
    const config = loadAgencyConfig();
    if (config.modelOverrides) {
      // 1. Exact match
      if (config.modelOverrides[model]) {
        const o = config.modelOverrides[model]!;
        return {
          contextWindow: o.contextWindow ?? 128_000,
          maxOutputTokens: o.maxOutputTokens ?? 4096,
          thinkingType: o.thinkingType ?? "none",
          specSource: "override",
        };
      }
      // 2. Base match
      const base = model.split("/").pop() ?? model;
      if (config.modelOverrides[base]) {
        const o = config.modelOverrides[base]!;
        return {
          contextWindow: o.contextWindow ?? 128_000,
          maxOutputTokens: o.maxOutputTokens ?? 4096,
          thinkingType: o.thinkingType ?? "none",
          specSource: "override",
        };
      }
      // 3. Substring match (avoid loose matches with provider names or short keys)
      const providers = ["openai", "anthropic", "google", "openrouter", "nvidia", "local"];
      for (const [key, o] of Object.entries(config.modelOverrides)) {
        if (!key || key.length < 4 || providers.includes(key.toLowerCase())) continue;
        const normalizedKey = key.toLowerCase();
        const normalizedModel = model.toLowerCase();
        if (normalizedModel.includes(normalizedKey) || normalizedKey.includes(normalizedModel)) {
          return {
            contextWindow: o.contextWindow ?? 128_000,
            maxOutputTokens: o.maxOutputTokens ?? 4096,
            thinkingType: o.thinkingType ?? "none",
            specSource: "override",
          };
        }
      }
    }
  } catch {
    // ignore
  }
  return null;
}

function getHeuristicsSpec(model: string): ModelSpec | null {
  const id = model.toLowerCase();

  // 1. Context size detection from name/suffix using flexible Regex
  let contextWindow = 128_000; // safe modern default fallback
  let contextDetected = false;

  // Search for explicit tokens suffix like 128k, 256k, 1m, 2m, etc.
  // Match forms like "-128k", "_128k", "128k", "1m", "2m"
  const suffixMatch = id.match(/(?:[-_]|\b)(\d+)(k|m)\b/i);
  if (suffixMatch) {
    const val = parseInt(suffixMatch[1], 10);
    const unit = suffixMatch[2].toLowerCase();
    if (unit === "k") {
      if (val === 256) contextWindow = 262_144;
      else if (val === 128) contextWindow = 131_072;
      else if (val === 64) contextWindow = 65_536;
      else if (val === 32) contextWindow = 32_768;
      else if (val === 16) contextWindow = 16_384;
      else if (val === 8) contextWindow = 8_192;
      else contextWindow = val * 1000;
      contextDetected = true;
    } else if (unit === "m") {
      contextWindow = val * 1_000_000;
      contextDetected = true;
    }
  }

  // If not matched by k/m, search for standard raw token values (e.g. 32768, 65536, 131072, 8192, 16384)
  if (!contextDetected) {
    const rawMatch = id.match(/\b(8192|16384|32768|65536|131072|262144|200000|128000)\b/);
    if (rawMatch) {
      contextWindow = parseInt(rawMatch[1], 10);
      contextDetected = true;
    }
  }

  // Family-based context heuristics if no explicit match is found in model ID
  if (!contextDetected) {
    if (id.includes("gemini-3") || id.includes("gemini-2.5") || id.includes("gemini-2.0")) {
      contextWindow = 1_048_576;
    } else if (id.includes("gemini")) {
      contextWindow = 1_000_000;
    } else if (id.includes("kimi-2.6") || id.includes("k2.6") || id.includes("kimi-k2.6")) {
      contextWindow = 262_144;
    } else if (id.includes("minimax-2.7") || id.includes("minimax-m2.7")) {
      contextWindow = 204_800;
    } else if (id.includes("llama-3.1") || id.includes("llama-3.2") || id.includes("llama-3.3") || id.includes("llama3.1") || id.includes("llama3.2") || id.includes("llama3.3")) {
      contextWindow = 131_072;
    } else if (id.includes("llama-3") || id.includes("llama3")) {
      contextWindow = 8_192;
    } else if (id.includes("claude-3-7") || id.includes("claude-sonnet-4") || id.includes("claude-3.7")) {
      contextWindow = 200_000;
    } else if (id.includes("claude-3-5") || id.includes("claude-3.5") || id.includes("claude-3")) {
      contextWindow = 200_000;
    } else if (id.includes("deepseek-v4")) {
      contextWindow = 1_048_576;
    } else if (id.includes("deepseek")) {
      contextWindow = 128_000;
    } else if (id.includes("qwen3")) {
      contextWindow = 1_000_000;
    } else if (id.includes("qwen")) {
      contextWindow = 128_000;
    } else if (id.includes("kimi") || id.includes("moonshot")) {
      contextWindow = 131_072;
    } else if (id.includes("minimax")) {
      contextWindow = 128_000;
    } else if (id.includes("gpt-5")) {
      contextWindow = 400_000;
    } else if (id.includes("gpt-4.1") || id.includes("gpt-4.5")) {
      contextWindow = 1_048_576;
    } else if (id.includes("gpt-4")) {
      contextWindow = 128_000;
    } else if (id.includes("gpt-3")) {
      contextWindow = 16_384;
    } else if (id.includes("nemotron-4-340b")) {
      contextWindow = 4_096;
    } else if (id.includes("glm-5")) {
      contextWindow = 202_752;
    } else if (id.includes("glm-4")) {
      contextWindow = 128_000;
    }
  }

  // 2. Reasoning / Thinking capability detection using robust regex
  let thinkingType: "budget" | "effort" | "none" = "none";
  let maxOutputTokens = 4096;

  // Matches if model name contains any reasoning indicators like r1, k1, o1, o3, o4, reasoning, thinking, thought, etc.
  const isReasoning = /(?:^|[-_/])(r1|reasoner|reasoning|thinking|thought|o1|o3|o4|k1)(?:[-_]|$)/i.test(id) 
    || /\b(r1|reasoner|reasoning|thinking|thought|k1)\b/i.test(id);

  if (isReasoning) {
    // OpenAI o-series uses effort-based scaling
    if (/(?:^|[-_/])(o1|o3|o4)(?:[-_]|$)/i.test(id)) {
      thinkingType = "effort";
      maxOutputTokens = 100_000;
    } else {
      thinkingType = "budget";
      if (id.includes("gemini-3") || id.includes("gemini-2.5") || id.includes("gemini-2.0") || id.includes("gemini")) {
        maxOutputTokens = id.includes("flash") && !id.includes("thinking") ? 8192 : 65536;
      } else if (id.includes("claude-3-7") || id.includes("claude-sonnet-4")) {
        maxOutputTokens = 128000;
      } else if (id.includes("deepseek") || id.includes("r1") || id.includes("reasoner")) {
        maxOutputTokens = 64000;
      } else {
        maxOutputTokens = 8192;
      }
    }
  } else {
    // Non-reasoning models
    thinkingType = "none";
    if (id.includes("gpt-5")) {
      maxOutputTokens = 128000;
    } else if (id.includes("gpt-4.1") || id.includes("gpt-4.5")) {
      maxOutputTokens = 32768;
    } else if (id.includes("gpt-4o")) {
      maxOutputTokens = 16384;
    } else if (id.includes("claude-3-5") || id.includes("claude-3-5") || id.includes("claude-3") || id.includes("claude-sonnet")) {
      maxOutputTokens = 8192;
    } else if (id.includes("gemini-3") || id.includes("gemini-2.5")) {
      maxOutputTokens = 65536;
    } else if (id.includes("gemini")) {
      maxOutputTokens = 8192;
    } else if (id.includes("kimi-2.6") || id.includes("k2.6")) {
      maxOutputTokens = 262142;
    } else if (id.includes("minimax-2.7") || id.includes("minimax-m2.7")) {
      maxOutputTokens = 131072;
    } else if (id.includes("qwen3")) {
      maxOutputTokens = 65536;
    } else if (id.includes("glm-5")) {
      maxOutputTokens = 131072;
    }
  }

  return {
    contextWindow,
    maxOutputTokens,
    thinkingType,
    specSource: "heuristics",
  };
}

export interface ThinkingVariant {
  name: string;
  value: string | number;
  desc: string;
}

export interface ModelThinkingConfig {
  supported: boolean;
  default: string | number;
  variants: ThinkingVariant[];
  /** Actual max output tokens for this model. */
  maxOutputTokens: number;
}

// ---- Registry ---------------------------------------------------------------

export const MODEL_REGISTRY: Record<string, ModelSpec> = {
  "ai21/jamba-large-1.7": { maxOutputTokens: 4096, contextWindow: 256000, thinkingType: "none" },
  "aion-1.0": { maxOutputTokens: 32768, contextWindow: 131072, thinkingType: "none" },
  "aion-1.0-mini": { maxOutputTokens: 32768, contextWindow: 131072, thinkingType: "none" },
  "aion-2.0": { maxOutputTokens: 32768, contextWindow: 131072, thinkingType: "none" },
  "aion-labs/aion-1.0": { maxOutputTokens: 32768, contextWindow: 131072, thinkingType: "none" },
  "aion-labs/aion-1.0-mini": { maxOutputTokens: 32768, contextWindow: 131072, thinkingType: "none" },
  "aion-labs/aion-2.0": { maxOutputTokens: 32768, contextWindow: 131072, thinkingType: "none" },
  "aion-labs/aion-rp-llama-3.1-8b": { maxOutputTokens: 32768, contextWindow: 32768, thinkingType: "none" },
  "aion-rp-llama-3.1-8b": { maxOutputTokens: 32768, contextWindow: 32768, thinkingType: "none" },
  "alfredpros/codellama-7b-instruct-solidity": { maxOutputTokens: 4096, contextWindow: 4096, thinkingType: "none" },
  "allenai/olmo-3-32b-think": { maxOutputTokens: 65536, contextWindow: 65536, thinkingType: "none" },
  "amazon/nova-2-lite-v1": { maxOutputTokens: 65535, contextWindow: 1000000, thinkingType: "none" },
  "amazon/nova-lite-v1": { maxOutputTokens: 5120, contextWindow: 300000, thinkingType: "none" },
  "amazon/nova-micro-v1": { maxOutputTokens: 5120, contextWindow: 128000, thinkingType: "none" },
  "amazon/nova-premier-v1": { maxOutputTokens: 32000, contextWindow: 1000000, thinkingType: "none" },
  "amazon/nova-pro-v1": { maxOutputTokens: 5120, contextWindow: 300000, thinkingType: "none" },
  "anthracite-org/magnum-v4-72b": { maxOutputTokens: 2048, contextWindow: 32768, thinkingType: "none" },
  "anthropic/claude-3-5-haiku": { maxOutputTokens: 8192, contextWindow: 200000, thinkingType: "none" },
  "anthropic/claude-3-5-sonnet": { maxOutputTokens: 8192, contextWindow: 200000, thinkingType: "none" },
  "anthropic/claude-3-7-sonnet": { maxOutputTokens: 128000, contextWindow: 200000, thinkingType: "budget" },
  "anthropic/claude-3-haiku": { maxOutputTokens: 4096, contextWindow: 200000, thinkingType: "none" },
  "anthropic/claude-3-opus": { maxOutputTokens: 4096, contextWindow: 200000, thinkingType: "none" },
  "anthropic/claude-3.5-haiku": { maxOutputTokens: 8192, contextWindow: 200000, thinkingType: "none" },
  "anthropic/claude-haiku-4.5": { maxOutputTokens: 64000, contextWindow: 200000, thinkingType: "none" },
  "anthropic/claude-opus-4": { maxOutputTokens: 32000, contextWindow: 200000, thinkingType: "none" },
  "anthropic/claude-opus-4.1": { maxOutputTokens: 32000, contextWindow: 200000, thinkingType: "none" },
  "anthropic/claude-opus-4.5": { maxOutputTokens: 64000, contextWindow: 200000, thinkingType: "none" },
  "anthropic/claude-opus-4.6": { maxOutputTokens: 128000, contextWindow: 1000000, thinkingType: "none" },
  "anthropic/claude-opus-4.6-fast": { maxOutputTokens: 128000, contextWindow: 1000000, thinkingType: "none" },
  "anthropic/claude-opus-4.7": { maxOutputTokens: 128000, contextWindow: 1000000, thinkingType: "none" },
  "anthropic/claude-opus-4.7-fast": { maxOutputTokens: 128000, contextWindow: 1000000, thinkingType: "none" },
  "anthropic/claude-sonnet-4": { maxOutputTokens: 128000, contextWindow: 200000, thinkingType: "budget" },
  "anthropic/claude-sonnet-4.5": { maxOutputTokens: 128000, contextWindow: 200000, thinkingType: "budget" },
  "anthropic/claude-sonnet-4.6": { maxOutputTokens: 128000, contextWindow: 200000, thinkingType: "budget" },
  "anthropic/claude-sonnet-4.7": { maxOutputTokens: 128000, contextWindow: 200000, thinkingType: "budget" },
  "arcee-ai/coder-large": { maxOutputTokens: 4096, contextWindow: 32768, thinkingType: "none" },
  "arcee-ai/maestro-reasoning": { maxOutputTokens: 32000, contextWindow: 131072, thinkingType: "none" },
  "arcee-ai/spotlight": { maxOutputTokens: 65537, contextWindow: 131072, thinkingType: "none" },
  "arcee-ai/trinity-large-thinking": { maxOutputTokens: 262144, contextWindow: 262144, thinkingType: "budget" },
  "arcee-ai/trinity-mini": { maxOutputTokens: 131072, contextWindow: 131072, thinkingType: "none" },
  "arcee-ai/virtuoso-large": { maxOutputTokens: 64000, contextWindow: 131072, thinkingType: "none" },
  "auto": { maxOutputTokens: 4096, contextWindow: 2000000, thinkingType: "none" },
  "baidu/cobuddy:free": { maxOutputTokens: 65536, contextWindow: 131072, thinkingType: "none" },
  "baidu/ernie-4.5-21b-a3b": { maxOutputTokens: 8000, contextWindow: 131072, thinkingType: "none" },
  "baidu/ernie-4.5-21b-a3b-thinking": { maxOutputTokens: 65536, contextWindow: 131072, thinkingType: "budget" },
  "baidu/ernie-4.5-300b-a47b": { maxOutputTokens: 12000, contextWindow: 131072, thinkingType: "none" },
  "baidu/ernie-4.5-vl-28b-a3b": { maxOutputTokens: 8000, contextWindow: 131072, thinkingType: "none" },
  "baidu/ernie-4.5-vl-424b-a47b": { maxOutputTokens: 16000, contextWindow: 131072, thinkingType: "none" },
  "baidu/qianfan-ocr-fast": { maxOutputTokens: 28672, contextWindow: 65536, thinkingType: "none" },
  "bodybuilder": { maxOutputTokens: 4096, contextWindow: 128000, thinkingType: "none" },
  "bytedance-seed/seed-1.6": { maxOutputTokens: 32768, contextWindow: 262144, thinkingType: "none" },
  "bytedance-seed/seed-1.6-flash": { maxOutputTokens: 32768, contextWindow: 262144, thinkingType: "none" },
  "bytedance-seed/seed-2.0-lite": { maxOutputTokens: 131072, contextWindow: 262144, thinkingType: "none" },
  "bytedance-seed/seed-2.0-mini": { maxOutputTokens: 131072, contextWindow: 262144, thinkingType: "none" },
  "bytedance/ui-tars-1.5-7b": { maxOutputTokens: 2048, contextWindow: 128000, thinkingType: "none" },
  "claude-3-5-haiku": { maxOutputTokens: 8192, contextWindow: 200000, thinkingType: "none" },
  "claude-3-5-sonnet": { maxOutputTokens: 8192, contextWindow: 200000, thinkingType: "none" },
  "claude-3-7-sonnet": { maxOutputTokens: 128000, contextWindow: 200000, thinkingType: "budget" },
  "claude-3-haiku": { maxOutputTokens: 4096, contextWindow: 200000, thinkingType: "none" },
  "claude-3-opus": { maxOutputTokens: 4096, contextWindow: 200000, thinkingType: "none" },
  "claude-3.5-haiku": { maxOutputTokens: 8192, contextWindow: 200000, thinkingType: "none" },
  "claude-haiku-4.5": { maxOutputTokens: 64000, contextWindow: 200000, thinkingType: "none" },
  "claude-haiku-latest": { maxOutputTokens: 64000, contextWindow: 200000, thinkingType: "none" },
  "claude-opus-4": { maxOutputTokens: 32000, contextWindow: 200000, thinkingType: "none" },
  "claude-opus-4.1": { maxOutputTokens: 32000, contextWindow: 200000, thinkingType: "none" },
  "claude-opus-4.5": { maxOutputTokens: 64000, contextWindow: 200000, thinkingType: "none" },
  "claude-opus-4.6": { maxOutputTokens: 128000, contextWindow: 1000000, thinkingType: "none" },
  "claude-opus-4.6-fast": { maxOutputTokens: 128000, contextWindow: 1000000, thinkingType: "none" },
  "claude-opus-4.7": { maxOutputTokens: 128000, contextWindow: 1000000, thinkingType: "none" },
  "claude-opus-4.7-fast": { maxOutputTokens: 128000, contextWindow: 1000000, thinkingType: "none" },
  "claude-opus-latest": { maxOutputTokens: 128000, contextWindow: 1000000, thinkingType: "none" },
  "claude-sonnet-4": { maxOutputTokens: 128000, contextWindow: 200000, thinkingType: "budget" },
  "claude-sonnet-4.5": { maxOutputTokens: 128000, contextWindow: 200000, thinkingType: "budget" },
  "claude-sonnet-4.6": { maxOutputTokens: 128000, contextWindow: 200000, thinkingType: "budget" },
  "claude-sonnet-4.7": { maxOutputTokens: 128000, contextWindow: 200000, thinkingType: "budget" },
  "claude-sonnet-latest": { maxOutputTokens: 128000, contextWindow: 1000000, thinkingType: "none" },
  "cobuddy:free": { maxOutputTokens: 65536, contextWindow: 131072, thinkingType: "none" },
  "codellama-7b-instruct-solidity": { maxOutputTokens: 4096, contextWindow: 4096, thinkingType: "none" },
  "coder-large": { maxOutputTokens: 4096, contextWindow: 32768, thinkingType: "none" },
  "codestral-2508": { maxOutputTokens: 4096, contextWindow: 256000, thinkingType: "none" },
  "cogito-v2.1-671b": { maxOutputTokens: 4096, contextWindow: 128000, thinkingType: "none" },
  "cognitivecomputations/dolphin-mistral-24b-venice-edition:free": { maxOutputTokens: 4096, contextWindow: 32768, thinkingType: "none" },
  "cohere/command-a": { maxOutputTokens: 8192, contextWindow: 256000, thinkingType: "none" },
  "cohere/command-r-08-2024": { maxOutputTokens: 4000, contextWindow: 128000, thinkingType: "none" },
  "cohere/command-r-plus-08-2024": { maxOutputTokens: 4000, contextWindow: 128000, thinkingType: "none" },
  "cohere/command-r7b-12-2024": { maxOutputTokens: 4000, contextWindow: 128000, thinkingType: "none" },
  "command-a": { maxOutputTokens: 8192, contextWindow: 256000, thinkingType: "none" },
  "command-r-08-2024": { maxOutputTokens: 4000, contextWindow: 128000, thinkingType: "none" },
  "command-r-plus-08-2024": { maxOutputTokens: 4000, contextWindow: 128000, thinkingType: "none" },
  "command-r7b-12-2024": { maxOutputTokens: 4000, contextWindow: 128000, thinkingType: "none" },
  "cydonia-24b-v4.1": { maxOutputTokens: 131072, contextWindow: 131072, thinkingType: "none" },
  "deepcogito/cogito-v2.1-671b": { maxOutputTokens: 4096, contextWindow: 128000, thinkingType: "none" },
  "deepseek-chat": { maxOutputTokens: 8192, contextWindow: 128000, thinkingType: "none" },
  "deepseek-chat-v3-0324": { maxOutputTokens: 16384, contextWindow: 163840, thinkingType: "none" },
  "deepseek-chat-v3.1": { maxOutputTokens: 32768, contextWindow: 163840, thinkingType: "none" },
  "deepseek-r1": { maxOutputTokens: 64000, contextWindow: 128000, thinkingType: "budget" },
  "deepseek-r1-0528": { maxOutputTokens: 32768, contextWindow: 163840, thinkingType: "budget" },
  "deepseek-r1-distill-llama-70b": { maxOutputTokens: 16384, contextWindow: 131072, thinkingType: "budget" },
  "deepseek-r1-distill-qwen-32b": { maxOutputTokens: 32768, contextWindow: 128000, thinkingType: "budget" },
  "deepseek-reasoner": { maxOutputTokens: 64000, contextWindow: 128000, thinkingType: "budget" },
  "deepseek-v3": { maxOutputTokens: 8192, contextWindow: 128000, thinkingType: "none" },
  "deepseek-v3.1-nex-n1": { maxOutputTokens: 163840, contextWindow: 131072, thinkingType: "none" },
  "deepseek-v3.1-terminus": { maxOutputTokens: 32768, contextWindow: 163840, thinkingType: "none" },
  "deepseek-v3.2": { maxOutputTokens: 65536, contextWindow: 131072, thinkingType: "none" },
  "deepseek-v3.2-exp": { maxOutputTokens: 65536, contextWindow: 163840, thinkingType: "none" },
  "deepseek-v3.2-speciale": { maxOutputTokens: 163840, contextWindow: 163840, thinkingType: "none" },
  "deepseek-v4-flash": { maxOutputTokens: 16384, contextWindow: 1048576, thinkingType: "none" },
  "deepseek-v4-flash:free": { maxOutputTokens: 384000, contextWindow: 1048576, thinkingType: "none" },
  "deepseek-v4-pro": { maxOutputTokens: 384000, contextWindow: 1048576, thinkingType: "none" },
  "deepseek/deepseek-chat": { maxOutputTokens: 8192, contextWindow: 128000, thinkingType: "none" },
  "deepseek/deepseek-chat-v3-0324": { maxOutputTokens: 16384, contextWindow: 163840, thinkingType: "none" },
  "deepseek/deepseek-chat-v3.1": { maxOutputTokens: 32768, contextWindow: 163840, thinkingType: "none" },
  "deepseek/deepseek-r1": { maxOutputTokens: 64000, contextWindow: 128000, thinkingType: "budget" },
  "deepseek/deepseek-r1-0528": { maxOutputTokens: 32768, contextWindow: 163840, thinkingType: "budget" },
  "deepseek/deepseek-r1-distill-llama-70b": { maxOutputTokens: 16384, contextWindow: 131072, thinkingType: "budget" },
  "deepseek/deepseek-r1-distill-qwen-32b": { maxOutputTokens: 32768, contextWindow: 128000, thinkingType: "budget" },
  "deepseek/deepseek-reasoner": { maxOutputTokens: 64000, contextWindow: 128000, thinkingType: "budget" },
  "deepseek/deepseek-v3": { maxOutputTokens: 8192, contextWindow: 128000, thinkingType: "none" },
  "deepseek/deepseek-v3.1-terminus": { maxOutputTokens: 32768, contextWindow: 163840, thinkingType: "none" },
  "deepseek/deepseek-v3.2": { maxOutputTokens: 65536, contextWindow: 131072, thinkingType: "none" },
  "deepseek/deepseek-v3.2-exp": { maxOutputTokens: 65536, contextWindow: 163840, thinkingType: "none" },
  "deepseek/deepseek-v3.2-speciale": { maxOutputTokens: 163840, contextWindow: 163840, thinkingType: "none" },
  "deepseek/deepseek-v4-flash": { maxOutputTokens: 16384, contextWindow: 1048576, thinkingType: "none" },
  "deepseek/deepseek-v4-flash:free": { maxOutputTokens: 384000, contextWindow: 1048576, thinkingType: "none" },
  "deepseek/deepseek-v4-pro": { maxOutputTokens: 384000, contextWindow: 1048576, thinkingType: "none" },
  "devstral-2512": { maxOutputTokens: 4096, contextWindow: 262144, thinkingType: "none" },
  "devstral-medium": { maxOutputTokens: 4096, contextWindow: 131072, thinkingType: "none" },
  "devstral-small": { maxOutputTokens: 4096, contextWindow: 131072, thinkingType: "none" },
  "dolphin-mistral-24b-venice-edition:free": { maxOutputTokens: 4096, contextWindow: 32768, thinkingType: "none" },
  "ernie-4.5-21b-a3b": { maxOutputTokens: 8000, contextWindow: 131072, thinkingType: "none" },
  "ernie-4.5-21b-a3b-thinking": { maxOutputTokens: 65536, contextWindow: 131072, thinkingType: "budget" },
  "ernie-4.5-300b-a47b": { maxOutputTokens: 12000, contextWindow: 131072, thinkingType: "none" },
  "ernie-4.5-vl-28b-a3b": { maxOutputTokens: 8000, contextWindow: 131072, thinkingType: "none" },
  "ernie-4.5-vl-424b-a47b": { maxOutputTokens: 16000, contextWindow: 131072, thinkingType: "none" },
  "essentialai/rnj-1-instruct": { maxOutputTokens: 4096, contextWindow: 32768, thinkingType: "none" },
  "free": { maxOutputTokens: 4096, contextWindow: 200000, thinkingType: "none" },
  "gemini-1.5-flash": { maxOutputTokens: 8192, contextWindow: 1048576, thinkingType: "none" },
  "gemini-1.5-pro": { maxOutputTokens: 8192, contextWindow: 2097152, thinkingType: "none" },
  "gemini-2.0-flash": { maxOutputTokens: 8192, contextWindow: 1048576, thinkingType: "budget" },
  "gemini-2.0-flash-001": { maxOutputTokens: 8192, contextWindow: 1000000, thinkingType: "budget" },
  "gemini-2.0-flash-lite-001": { maxOutputTokens: 8192, contextWindow: 1048576, thinkingType: "budget" },
  "gemini-2.0-pro": { maxOutputTokens: 65536, contextWindow: 2097152, thinkingType: "budget" },
  "gemini-2.5-flash": { maxOutputTokens: 65536, contextWindow: 1048576, thinkingType: "budget" },
  "gemini-2.5-flash-image": { maxOutputTokens: 32768, contextWindow: 32768, thinkingType: "budget" },
  "gemini-2.5-flash-lite": { maxOutputTokens: 65535, contextWindow: 1048576, thinkingType: "budget" },
  "gemini-2.5-flash-lite-preview-09-2025": { maxOutputTokens: 65535, contextWindow: 1048576, thinkingType: "budget" },
  "gemini-2.5-pro": { maxOutputTokens: 65536, contextWindow: 2097152, thinkingType: "budget" },
  "gemini-2.5-pro-preview": { maxOutputTokens: 65536, contextWindow: 1048576, thinkingType: "budget" },
  "gemini-2.5-pro-preview-05-06": { maxOutputTokens: 65535, contextWindow: 1048576, thinkingType: "budget" },
  "gemini-3-flash": { maxOutputTokens: 65536, contextWindow: 1048576, thinkingType: "budget" },
  "gemini-3-flash-preview": { maxOutputTokens: 65536, contextWindow: 1048576, thinkingType: "budget" },
  "gemini-3-pro": { maxOutputTokens: 65536, contextWindow: 2097152, thinkingType: "budget" },
  "gemini-3-pro-image-preview": { maxOutputTokens: 32768, contextWindow: 65536, thinkingType: "budget" },
  "gemini-3.1-flash-image-preview": { maxOutputTokens: 65536, contextWindow: 131072, thinkingType: "budget" },
  "gemini-3.1-flash-lite": { maxOutputTokens: 65536, contextWindow: 1048576, thinkingType: "budget" },
  "gemini-3.1-flash-lite-preview": { maxOutputTokens: 65536, contextWindow: 1048576, thinkingType: "budget" },
  "gemini-3.1-pro-preview": { maxOutputTokens: 65536, contextWindow: 1048576, thinkingType: "budget" },
  "gemini-3.1-pro-preview-customtools": { maxOutputTokens: 65536, contextWindow: 1048756, thinkingType: "budget" },
  "gemini-3.5-flash": { maxOutputTokens: 65536, contextWindow: 1048576, thinkingType: "budget" },
  "gemini-flash-latest": { maxOutputTokens: 65536, contextWindow: 1048576, thinkingType: "none" },
  "gemini-pro-latest": { maxOutputTokens: 65536, contextWindow: 1048576, thinkingType: "none" },
  "gemma-2-27b-it": { maxOutputTokens: 2048, contextWindow: 8192, thinkingType: "none" },
  "gemma-3-12b-it": { maxOutputTokens: 16384, contextWindow: 131072, thinkingType: "none" },
  "gemma-3-27b-it": { maxOutputTokens: 16384, contextWindow: 131072, thinkingType: "none" },
  "gemma-3-4b-it": { maxOutputTokens: 16384, contextWindow: 131072, thinkingType: "none" },
  "gemma-3n-e4b-it": { maxOutputTokens: 4096, contextWindow: 32768, thinkingType: "none" },
  "gemma-4-26b-a4b-it": { maxOutputTokens: 4096, contextWindow: 262144, thinkingType: "none" },
  "gemma-4-26b-a4b-it:free": { maxOutputTokens: 32768, contextWindow: 262144, thinkingType: "none" },
  "gemma-4-31b-it": { maxOutputTokens: 16384, contextWindow: 262144, thinkingType: "none" },
  "gemma-4-31b-it:free": { maxOutputTokens: 32768, contextWindow: 262144, thinkingType: "none" },
  "glm-4": { maxOutputTokens: 4096, contextWindow: 128000, thinkingType: "none" },
  "glm-4-32b": { maxOutputTokens: 4096, contextWindow: 128000, thinkingType: "none" },
  "glm-4-plus": { maxOutputTokens: 8192, contextWindow: 128000, thinkingType: "none" },
  "glm-4.5": { maxOutputTokens: 98304, contextWindow: 131072, thinkingType: "none" },
  "glm-4.5-air": { maxOutputTokens: 98304, contextWindow: 131072, thinkingType: "none" },
  "glm-4.5-air:free": { maxOutputTokens: 96000, contextWindow: 131072, thinkingType: "none" },
  "glm-4.5v": { maxOutputTokens: 16384, contextWindow: 65536, thinkingType: "none" },
  "glm-4.6": { maxOutputTokens: 131072, contextWindow: 202752, thinkingType: "none" },
  "glm-4.6v": { maxOutputTokens: 24000, contextWindow: 131072, thinkingType: "none" },
  "glm-4.7": { maxOutputTokens: 131072, contextWindow: 202752, thinkingType: "none" },
  "glm-4.7-flash": { maxOutputTokens: 16384, contextWindow: 202752, thinkingType: "none" },
  "glm-5": { maxOutputTokens: 131072, contextWindow: 202752, thinkingType: "none" },
  "glm-5-turbo": { maxOutputTokens: 131072, contextWindow: 202752, thinkingType: "none" },
  "glm-5.1": { maxOutputTokens: 131072, contextWindow: 202752, thinkingType: "none" },
  "glm-5v-turbo": { maxOutputTokens: 131072, contextWindow: 202752, thinkingType: "none" },
  "google/gemini-1.5-flash": { maxOutputTokens: 8192, contextWindow: 1048576, thinkingType: "none" },
  "google/gemini-1.5-pro": { maxOutputTokens: 8192, contextWindow: 2097152, thinkingType: "none" },
  "google/gemini-2.0-flash": { maxOutputTokens: 8192, contextWindow: 1048576, thinkingType: "budget" },
  "google/gemini-2.0-flash-001": { maxOutputTokens: 8192, contextWindow: 1000000, thinkingType: "budget" },
  "google/gemini-2.0-flash-lite-001": { maxOutputTokens: 8192, contextWindow: 1048576, thinkingType: "budget" },
  "google/gemini-2.0-pro": { maxOutputTokens: 65536, contextWindow: 2097152, thinkingType: "budget" },
  "google/gemini-2.5-flash": { maxOutputTokens: 65536, contextWindow: 1048576, thinkingType: "budget" },
  "google/gemini-2.5-flash-image": { maxOutputTokens: 32768, contextWindow: 32768, thinkingType: "budget" },
  "google/gemini-2.5-flash-lite": { maxOutputTokens: 65535, contextWindow: 1048576, thinkingType: "budget" },
  "google/gemini-2.5-flash-lite-preview-09-2025": { maxOutputTokens: 65535, contextWindow: 1048576, thinkingType: "budget" },
  "google/gemini-2.5-pro": { maxOutputTokens: 65536, contextWindow: 2097152, thinkingType: "budget" },
  "google/gemini-2.5-pro-preview": { maxOutputTokens: 65536, contextWindow: 1048576, thinkingType: "budget" },
  "google/gemini-2.5-pro-preview-05-06": { maxOutputTokens: 65535, contextWindow: 1048576, thinkingType: "budget" },
  "google/gemini-3-flash": { maxOutputTokens: 65536, contextWindow: 1048576, thinkingType: "budget" },
  "google/gemini-3-flash-preview": { maxOutputTokens: 65536, contextWindow: 1048576, thinkingType: "budget" },
  "google/gemini-3-pro": { maxOutputTokens: 65536, contextWindow: 2097152, thinkingType: "budget" },
  "google/gemini-3-pro-image-preview": { maxOutputTokens: 32768, contextWindow: 65536, thinkingType: "budget" },
  "google/gemini-3.1-flash-image-preview": { maxOutputTokens: 65536, contextWindow: 131072, thinkingType: "budget" },
  "google/gemini-3.1-flash-lite": { maxOutputTokens: 65536, contextWindow: 1048576, thinkingType: "budget" },
  "google/gemini-3.1-flash-lite-preview": { maxOutputTokens: 65536, contextWindow: 1048576, thinkingType: "budget" },
  "google/gemini-3.1-pro-preview": { maxOutputTokens: 65536, contextWindow: 1048576, thinkingType: "budget" },
  "google/gemini-3.1-pro-preview-customtools": { maxOutputTokens: 65536, contextWindow: 1048756, thinkingType: "budget" },
  "google/gemini-3.5-flash": { maxOutputTokens: 65536, contextWindow: 1048576, thinkingType: "budget" },
  "google/gemma-2-27b-it": { maxOutputTokens: 2048, contextWindow: 8192, thinkingType: "none" },
  "google/gemma-3-12b-it": { maxOutputTokens: 16384, contextWindow: 131072, thinkingType: "none" },
  "google/gemma-3-27b-it": { maxOutputTokens: 16384, contextWindow: 131072, thinkingType: "none" },
  "google/gemma-3-4b-it": { maxOutputTokens: 16384, contextWindow: 131072, thinkingType: "none" },
  "google/gemma-3n-e4b-it": { maxOutputTokens: 4096, contextWindow: 32768, thinkingType: "none" },
  "google/gemma-4-26b-a4b-it": { maxOutputTokens: 4096, contextWindow: 262144, thinkingType: "none" },
  "google/gemma-4-26b-a4b-it:free": { maxOutputTokens: 32768, contextWindow: 262144, thinkingType: "none" },
  "google/gemma-4-31b-it": { maxOutputTokens: 16384, contextWindow: 262144, thinkingType: "none" },
  "google/gemma-4-31b-it:free": { maxOutputTokens: 32768, contextWindow: 262144, thinkingType: "none" },
  "google/lyria-3-clip-preview": { maxOutputTokens: 65536, contextWindow: 1048576, thinkingType: "none" },
  "google/lyria-3-pro-preview": { maxOutputTokens: 65536, contextWindow: 1048576, thinkingType: "none" },
  "gpt-3.5-turbo": { maxOutputTokens: 4096, contextWindow: 16385, thinkingType: "none" },
  "gpt-3.5-turbo-0613": { maxOutputTokens: 4096, contextWindow: 4095, thinkingType: "none" },
  "gpt-3.5-turbo-16k": { maxOutputTokens: 4096, contextWindow: 16385, thinkingType: "none" },
  "gpt-3.5-turbo-instruct": { maxOutputTokens: 4096, contextWindow: 4095, thinkingType: "none" },
  "gpt-4": { maxOutputTokens: 4096, contextWindow: 8192, thinkingType: "none" },
  "gpt-4-0314": { maxOutputTokens: 4096, contextWindow: 8191, thinkingType: "none" },
  "gpt-4-1106-preview": { maxOutputTokens: 4096, contextWindow: 128000, thinkingType: "none" },
  "gpt-4-turbo": { maxOutputTokens: 4096, contextWindow: 128000, thinkingType: "none" },
  "gpt-4-turbo-preview": { maxOutputTokens: 4096, contextWindow: 128000, thinkingType: "none" },
  "gpt-4.1": { maxOutputTokens: 4096, contextWindow: 1047576, thinkingType: "none" },
  "gpt-4.1-mini": { maxOutputTokens: 32768, contextWindow: 1047576, thinkingType: "none" },
  "gpt-4.1-nano": { maxOutputTokens: 32768, contextWindow: 1047576, thinkingType: "none" },
  "gpt-4.5": { maxOutputTokens: 16384, contextWindow: 128000, thinkingType: "none" },
  "gpt-4.5-preview": { maxOutputTokens: 16384, contextWindow: 128000, thinkingType: "none" },
  "gpt-4o": { maxOutputTokens: 16384, contextWindow: 128000, thinkingType: "none" },
  "gpt-4o-2024-05-13": { maxOutputTokens: 4096, contextWindow: 128000, thinkingType: "none" },
  "gpt-4o-2024-08-06": { maxOutputTokens: 16384, contextWindow: 128000, thinkingType: "none" },
  "gpt-4o-2024-11-20": { maxOutputTokens: 16384, contextWindow: 128000, thinkingType: "none" },
  "gpt-4o-audio-preview": { maxOutputTokens: 16384, contextWindow: 128000, thinkingType: "none" },
  "gpt-4o-mini": { maxOutputTokens: 16384, contextWindow: 128000, thinkingType: "none" },
  "gpt-4o-mini-2024-07-18": { maxOutputTokens: 16384, contextWindow: 128000, thinkingType: "none" },
  "gpt-4o-mini-search-preview": { maxOutputTokens: 16384, contextWindow: 128000, thinkingType: "none" },
  "gpt-4o-search-preview": { maxOutputTokens: 16384, contextWindow: 128000, thinkingType: "none" },
  "gpt-5": { maxOutputTokens: 128000, contextWindow: 400000, thinkingType: "none" },
  "gpt-5-chat": { maxOutputTokens: 16384, contextWindow: 128000, thinkingType: "none" },
  "gpt-5-codex": { maxOutputTokens: 128000, contextWindow: 400000, thinkingType: "none" },
  "gpt-5-image": { maxOutputTokens: 128000, contextWindow: 400000, thinkingType: "none" },
  "gpt-5-image-mini": { maxOutputTokens: 128000, contextWindow: 400000, thinkingType: "none" },
  "gpt-5-mini": { maxOutputTokens: 128000, contextWindow: 400000, thinkingType: "none" },
  "gpt-5-nano": { maxOutputTokens: 4096, contextWindow: 400000, thinkingType: "none" },
  "gpt-5-pro": { maxOutputTokens: 128000, contextWindow: 400000, thinkingType: "none" },
  "gpt-5.1": { maxOutputTokens: 128000, contextWindow: 400000, thinkingType: "none" },
  "gpt-5.1-chat": { maxOutputTokens: 16384, contextWindow: 128000, thinkingType: "none" },
  "gpt-5.1-codex": { maxOutputTokens: 128000, contextWindow: 400000, thinkingType: "none" },
  "gpt-5.1-codex-max": { maxOutputTokens: 128000, contextWindow: 400000, thinkingType: "none" },
  "gpt-5.1-codex-mini": { maxOutputTokens: 128000, contextWindow: 400000, thinkingType: "none" },
  "gpt-5.2": { maxOutputTokens: 128000, contextWindow: 400000, thinkingType: "none" },
  "gpt-5.2-chat": { maxOutputTokens: 32000, contextWindow: 128000, thinkingType: "none" },
  "gpt-5.2-codex": { maxOutputTokens: 128000, contextWindow: 400000, thinkingType: "none" },
  "gpt-5.2-pro": { maxOutputTokens: 128000, contextWindow: 400000, thinkingType: "none" },
  "gpt-5.3-chat": { maxOutputTokens: 16384, contextWindow: 128000, thinkingType: "none" },
  "gpt-5.3-codex": { maxOutputTokens: 128000, contextWindow: 400000, thinkingType: "none" },
  "gpt-5.4": { maxOutputTokens: 128000, contextWindow: 1050000, thinkingType: "none" },
  "gpt-5.4-image-2": { maxOutputTokens: 128000, contextWindow: 272000, thinkingType: "none" },
  "gpt-5.4-mini": { maxOutputTokens: 128000, contextWindow: 400000, thinkingType: "none" },
  "gpt-5.4-nano": { maxOutputTokens: 128000, contextWindow: 400000, thinkingType: "none" },
  "gpt-5.4-pro": { maxOutputTokens: 128000, contextWindow: 1050000, thinkingType: "none" },
  "gpt-5.5": { maxOutputTokens: 128000, contextWindow: 1050000, thinkingType: "none" },
  "gpt-5.5-pro": { maxOutputTokens: 128000, contextWindow: 1050000, thinkingType: "none" },
  "gpt-audio": { maxOutputTokens: 16384, contextWindow: 128000, thinkingType: "none" },
  "gpt-audio-mini": { maxOutputTokens: 16384, contextWindow: 128000, thinkingType: "none" },
  "gpt-chat-latest": { maxOutputTokens: 128000, contextWindow: 400000, thinkingType: "none" },
  "gpt-latest": { maxOutputTokens: 128000, contextWindow: 1050000, thinkingType: "none" },
  "gpt-mini-latest": { maxOutputTokens: 128000, contextWindow: 400000, thinkingType: "none" },
  "gpt-oss-120b": { maxOutputTokens: 4096, contextWindow: 131072, thinkingType: "none" },
  "gpt-oss-120b:free": { maxOutputTokens: 131072, contextWindow: 131072, thinkingType: "none" },
  "gpt-oss-20b": { maxOutputTokens: 131072, contextWindow: 131072, thinkingType: "none" },
  "gpt-oss-20b:free": { maxOutputTokens: 8192, contextWindow: 131072, thinkingType: "none" },
  "gpt-oss-safeguard-20b": { maxOutputTokens: 65536, contextWindow: 131072, thinkingType: "none" },
  "granite-4.0-h-micro": { maxOutputTokens: 131000, contextWindow: 131000, thinkingType: "none" },
  "granite-4.1-8b": { maxOutputTokens: 131072, contextWindow: 131072, thinkingType: "none" },
  "grok-4.20": { maxOutputTokens: 4096, contextWindow: 2000000, thinkingType: "none" },
  "grok-4.20-multi-agent": { maxOutputTokens: 4096, contextWindow: 2000000, thinkingType: "none" },
  "grok-4.3": { maxOutputTokens: 4096, contextWindow: 1000000, thinkingType: "none" },
  "grok-build-0.1": { maxOutputTokens: 4096, contextWindow: 256000, thinkingType: "none" },
  "gryphe/mythomax-l2-13b": { maxOutputTokens: 4096, contextWindow: 4096, thinkingType: "none" },
  "hermes-2-pro-llama-3-8b": { maxOutputTokens: 8192, contextWindow: 8192, thinkingType: "none" },
  "hermes-3-llama-3.1-405b": { maxOutputTokens: 16384, contextWindow: 131072, thinkingType: "none" },
  "hermes-3-llama-3.1-405b:free": { maxOutputTokens: 4096, contextWindow: 131072, thinkingType: "none" },
  "hermes-3-llama-3.1-70b": { maxOutputTokens: 16384, contextWindow: 131072, thinkingType: "none" },
  "hermes-4-405b": { maxOutputTokens: 4096, contextWindow: 131072, thinkingType: "none" },
  "hermes-4-70b": { maxOutputTokens: 4096, contextWindow: 131072, thinkingType: "none" },
  "hunyuan-a13b-instruct": { maxOutputTokens: 131072, contextWindow: 131072, thinkingType: "none" },
  "hy3-preview": { maxOutputTokens: 262144, contextWindow: 262144, thinkingType: "none" },
  "ibm-granite/granite-4.0-h-micro": { maxOutputTokens: 131000, contextWindow: 131000, thinkingType: "none" },
  "ibm-granite/granite-4.1-8b": { maxOutputTokens: 131072, contextWindow: 131072, thinkingType: "none" },
  "inception/mercury-2": { maxOutputTokens: 50000, contextWindow: 128000, thinkingType: "none" },
  "inclusionai/ling-2.6-1t": { maxOutputTokens: 32768, contextWindow: 262144, thinkingType: "none" },
  "inclusionai/ling-2.6-flash": { maxOutputTokens: 32768, contextWindow: 262144, thinkingType: "none" },
  "inclusionai/ring-2.6-1t": { maxOutputTokens: 65536, contextWindow: 262144, thinkingType: "none" },
  "inflection-3-pi": { maxOutputTokens: 1024, contextWindow: 8000, thinkingType: "none" },
  "inflection-3-productivity": { maxOutputTokens: 1024, contextWindow: 8000, thinkingType: "none" },
  "inflection/inflection-3-pi": { maxOutputTokens: 1024, contextWindow: 8000, thinkingType: "none" },
  "inflection/inflection-3-productivity": { maxOutputTokens: 1024, contextWindow: 8000, thinkingType: "none" },
  "intellect-3": { maxOutputTokens: 131072, contextWindow: 131072, thinkingType: "none" },
  "jamba-large-1.7": { maxOutputTokens: 4096, contextWindow: 256000, thinkingType: "none" },
  "kat-coder-pro-v2": { maxOutputTokens: 80000, contextWindow: 256000, thinkingType: "none" },
  "kimi-2.6": { maxOutputTokens: 262142, contextWindow: 262144, thinkingType: "none" },
  "kimi-k2": { maxOutputTokens: 32768, contextWindow: 131072, thinkingType: "none" },
  "kimi-k2-0905": { maxOutputTokens: 262144, contextWindow: 262144, thinkingType: "none" },
  "kimi-k2-thinking": { maxOutputTokens: 262144, contextWindow: 262144, thinkingType: "budget" },
  "kimi-k2.5": { maxOutputTokens: 262144, contextWindow: 262144, thinkingType: "none" },
  "kimi-k2.6": { maxOutputTokens: 262142, contextWindow: 262144, thinkingType: "none" },
  "kimi-latest": { maxOutputTokens: 262142, contextWindow: 262144, thinkingType: "none" },
  "kwaipilot/kat-coder-pro-v2": { maxOutputTokens: 80000, contextWindow: 256000, thinkingType: "none" },
  "l3-euryale-70b": { maxOutputTokens: 8192, contextWindow: 8192, thinkingType: "effort", effortLevels: ["low","medium","high"] },
  "l3-lunaris-8b": { maxOutputTokens: 16384, contextWindow: 8192, thinkingType: "effort", effortLevels: ["low","medium","high"] },
  "l3.1-70b-hanami-x1": { maxOutputTokens: 100000, contextWindow: 16000, thinkingType: "effort", effortLevels: ["low","medium","high"] },
  "l3.1-euryale-70b": { maxOutputTokens: 16384, contextWindow: 131072, thinkingType: "effort", effortLevels: ["low","medium","high"] },
  "l3.3-euryale-70b": { maxOutputTokens: 16384, contextWindow: 131072, thinkingType: "effort", effortLevels: ["low","medium","high"] },
  "laguna-m.1:free": { maxOutputTokens: 32768, contextWindow: 262144, thinkingType: "none" },
  "laguna-xs.2:free": { maxOutputTokens: 8192, contextWindow: 131072, thinkingType: "none" },
  "lfm-2-24b-a2b": { maxOutputTokens: 4096, contextWindow: 128000, thinkingType: "none" },
  "lfm-2.5-1.2b-instruct:free": { maxOutputTokens: 4096, contextWindow: 32768, thinkingType: "none" },
  "lfm-2.5-1.2b-thinking:free": { maxOutputTokens: 4096, contextWindow: 32768, thinkingType: "budget" },
  "ling-2.6-1t": { maxOutputTokens: 32768, contextWindow: 262144, thinkingType: "none" },
  "ling-2.6-flash": { maxOutputTokens: 32768, contextWindow: 262144, thinkingType: "none" },
  "liquid/lfm-2-24b-a2b": { maxOutputTokens: 4096, contextWindow: 128000, thinkingType: "none" },
  "liquid/lfm-2.5-1.2b-instruct:free": { maxOutputTokens: 4096, contextWindow: 32768, thinkingType: "none" },
  "liquid/lfm-2.5-1.2b-thinking:free": { maxOutputTokens: 4096, contextWindow: 32768, thinkingType: "budget" },
  "llama-3-70b-instruct": { maxOutputTokens: 8192, contextWindow: 8192, thinkingType: "none" },
  "llama-3-8b-instruct": { maxOutputTokens: 8192, contextWindow: 8192, thinkingType: "none" },
  "llama-3.1-405b-instruct": { maxOutputTokens: 16384, contextWindow: 131072, thinkingType: "none" },
  "llama-3.1-70b-instruct": { maxOutputTokens: 16384, contextWindow: 131072, thinkingType: "none" },
  "llama-3.1-8b-instruct": { maxOutputTokens: 16384, contextWindow: 131072, thinkingType: "none" },
  "llama-3.2-11b-vision-instruct": { maxOutputTokens: 16384, contextWindow: 131072, thinkingType: "none" },
  "llama-3.2-1b-instruct": { maxOutputTokens: 8192, contextWindow: 131072, thinkingType: "none" },
  "llama-3.2-3b-instruct": { maxOutputTokens: 8192, contextWindow: 131072, thinkingType: "none" },
  "llama-3.2-3b-instruct:free": { maxOutputTokens: 4096, contextWindow: 131072, thinkingType: "none" },
  "llama-3.3-70b-instruct": { maxOutputTokens: 16384, contextWindow: 131072, thinkingType: "none" },
  "llama-3.3-70b-instruct:free": { maxOutputTokens: 4096, contextWindow: 131072, thinkingType: "none" },
  "llama-3.3-nemotron-super-49b-v1.5": { maxOutputTokens: 16384, contextWindow: 131072, thinkingType: "none" },
  "llama-4-maverick": { maxOutputTokens: 16384, contextWindow: 1048576, thinkingType: "none" },
  "llama-4-scout": { maxOutputTokens: 16384, contextWindow: 10000000, thinkingType: "none" },
  "llama-guard-3-8b": { maxOutputTokens: 131072, contextWindow: 131072, thinkingType: "none" },
  "llama-guard-4-12b": { maxOutputTokens: 16384, contextWindow: 163840, thinkingType: "none" },
  "lyria-3-clip-preview": { maxOutputTokens: 65536, contextWindow: 1048576, thinkingType: "none" },
  "lyria-3-pro-preview": { maxOutputTokens: 65536, contextWindow: 1048576, thinkingType: "none" },
  "maestro-reasoning": { maxOutputTokens: 32000, contextWindow: 131072, thinkingType: "none" },
  "magnum-v4-72b": { maxOutputTokens: 2048, contextWindow: 32768, thinkingType: "none" },
  "mancer/weaver": { maxOutputTokens: 2000, contextWindow: 8000, thinkingType: "none" },
  "mercury-2": { maxOutputTokens: 50000, contextWindow: 128000, thinkingType: "none" },
  "meta-llama/llama-3-70b-instruct": { maxOutputTokens: 8192, contextWindow: 8192, thinkingType: "none" },
  "meta-llama/llama-3-8b-instruct": { maxOutputTokens: 8192, contextWindow: 8192, thinkingType: "none" },
  "meta-llama/llama-3.1-405b-instruct": { maxOutputTokens: 16384, contextWindow: 131072, thinkingType: "none" },
  "meta-llama/llama-3.1-70b-instruct": { maxOutputTokens: 16384, contextWindow: 131072, thinkingType: "none" },
  "meta-llama/llama-3.1-8b-instruct": { maxOutputTokens: 16384, contextWindow: 131072, thinkingType: "none" },
  "meta-llama/llama-3.2-11b-vision-instruct": { maxOutputTokens: 16384, contextWindow: 131072, thinkingType: "none" },
  "meta-llama/llama-3.2-1b-instruct": { maxOutputTokens: 8192, contextWindow: 131072, thinkingType: "none" },
  "meta-llama/llama-3.2-3b-instruct": { maxOutputTokens: 8192, contextWindow: 131072, thinkingType: "none" },
  "meta-llama/llama-3.2-3b-instruct:free": { maxOutputTokens: 4096, contextWindow: 131072, thinkingType: "none" },
  "meta-llama/llama-3.3-70b-instruct": { maxOutputTokens: 16384, contextWindow: 131072, thinkingType: "none" },
  "meta-llama/llama-3.3-70b-instruct:free": { maxOutputTokens: 4096, contextWindow: 131072, thinkingType: "none" },
  "meta-llama/llama-4-maverick": { maxOutputTokens: 16384, contextWindow: 1048576, thinkingType: "none" },
  "meta-llama/llama-4-scout": { maxOutputTokens: 16384, contextWindow: 10000000, thinkingType: "none" },
  "meta-llama/llama-guard-3-8b": { maxOutputTokens: 131072, contextWindow: 131072, thinkingType: "none" },
  "meta-llama/llama-guard-4-12b": { maxOutputTokens: 16384, contextWindow: 163840, thinkingType: "none" },
  "microsoft/phi-4": { maxOutputTokens: 16384, contextWindow: 16384, thinkingType: "none" },
  "microsoft/phi-4-mini-instruct": { maxOutputTokens: 128000, contextWindow: 131072, thinkingType: "none" },
  "microsoft/wizardlm-2-8x22b": { maxOutputTokens: 8000, contextWindow: 65536, thinkingType: "none" },
  "mimo-v2-flash": { maxOutputTokens: 65536, contextWindow: 262144, thinkingType: "none" },
  "mimo-v2-omni": { maxOutputTokens: 65536, contextWindow: 262144, thinkingType: "none" },
  "mimo-v2-pro": { maxOutputTokens: 131072, contextWindow: 1048576, thinkingType: "none" },
  "mimo-v2.5": { maxOutputTokens: 131072, contextWindow: 1048576, thinkingType: "none" },
  "mimo-v2.5-pro": { maxOutputTokens: 131072, contextWindow: 1048576, thinkingType: "none" },
  "minimax-01": { maxOutputTokens: 1000192, contextWindow: 1000192, thinkingType: "none" },
  "minimax-2.7": { maxOutputTokens: 131072, contextWindow: 204800, thinkingType: "none" },
  "minimax-m1": { maxOutputTokens: 80000, contextWindow: 1000000, thinkingType: "none" },
  "minimax-m2": { maxOutputTokens: 196608, contextWindow: 204800, thinkingType: "none" },
  "minimax-m2-her": { maxOutputTokens: 2048, contextWindow: 65536, thinkingType: "none" },
  "minimax-m2.1": { maxOutputTokens: 196608, contextWindow: 204800, thinkingType: "none" },
  "minimax-m2.5": { maxOutputTokens: 196608, contextWindow: 204800, thinkingType: "none" },
  "minimax-m2.5:free": { maxOutputTokens: 8192, contextWindow: 204800, thinkingType: "none" },
  "minimax-m2.7": { maxOutputTokens: 131072, contextWindow: 204800, thinkingType: "none" },
  "minimax/minimax-01": { maxOutputTokens: 1000192, contextWindow: 1000192, thinkingType: "none" },
  "minimax/minimax-2.7": { maxOutputTokens: 131072, contextWindow: 204800, thinkingType: "none" },
  "minimax/minimax-m1": { maxOutputTokens: 80000, contextWindow: 1000000, thinkingType: "none" },
  "minimax/minimax-m2": { maxOutputTokens: 196608, contextWindow: 204800, thinkingType: "none" },
  "minimax/minimax-m2-her": { maxOutputTokens: 2048, contextWindow: 65536, thinkingType: "none" },
  "minimax/minimax-m2.1": { maxOutputTokens: 196608, contextWindow: 204800, thinkingType: "none" },
  "minimax/minimax-m2.5": { maxOutputTokens: 196608, contextWindow: 204800, thinkingType: "none" },
  "minimax/minimax-m2.5:free": { maxOutputTokens: 8192, contextWindow: 204800, thinkingType: "none" },
  "minimax/minimax-m2.7": { maxOutputTokens: 131072, contextWindow: 204800, thinkingType: "none" },
  "ministral-14b-2512": { maxOutputTokens: 4096, contextWindow: 262144, thinkingType: "none" },
  "ministral-3b-2512": { maxOutputTokens: 4096, contextWindow: 131072, thinkingType: "none" },
  "ministral-8b-2512": { maxOutputTokens: 4096, contextWindow: 262144, thinkingType: "none" },
  "mistral-7b-instruct-v0.1": { maxOutputTokens: 2824, contextWindow: 4096, thinkingType: "none" },
  "mistral-large": { maxOutputTokens: 4096, contextWindow: 128000, thinkingType: "none" },
  "mistral-large-2407": { maxOutputTokens: 4096, contextWindow: 131072, thinkingType: "none" },
  "mistral-large-2411": { maxOutputTokens: 4096, contextWindow: 131072, thinkingType: "none" },
  "mistral-large-2512": { maxOutputTokens: 4096, contextWindow: 262144, thinkingType: "none" },
  "mistral-medium-3": { maxOutputTokens: 4096, contextWindow: 131072, thinkingType: "none" },
  "mistral-medium-3-5": { maxOutputTokens: 4096, contextWindow: 262144, thinkingType: "none" },
  "mistral-medium-3.1": { maxOutputTokens: 4096, contextWindow: 131072, thinkingType: "none" },
  "mistral-nemo": { maxOutputTokens: 4096, contextWindow: 131072, thinkingType: "none" },
  "mistral-saba": { maxOutputTokens: 4096, contextWindow: 32768, thinkingType: "none" },
  "mistral-small-24b-instruct-2501": { maxOutputTokens: 16384, contextWindow: 32768, thinkingType: "none" },
  "mistral-small-2603": { maxOutputTokens: 4096, contextWindow: 262144, thinkingType: "none" },
  "mistral-small-3.1-24b-instruct": { maxOutputTokens: 128000, contextWindow: 128000, thinkingType: "none" },
  "mistral-small-3.2-24b-instruct": { maxOutputTokens: 16384, contextWindow: 128000, thinkingType: "none" },
  "mistralai/codestral-2508": { maxOutputTokens: 4096, contextWindow: 256000, thinkingType: "none" },
  "mistralai/devstral-2512": { maxOutputTokens: 4096, contextWindow: 262144, thinkingType: "none" },
  "mistralai/devstral-medium": { maxOutputTokens: 4096, contextWindow: 131072, thinkingType: "none" },
  "mistralai/devstral-small": { maxOutputTokens: 4096, contextWindow: 131072, thinkingType: "none" },
  "mistralai/ministral-14b-2512": { maxOutputTokens: 4096, contextWindow: 262144, thinkingType: "none" },
  "mistralai/ministral-3b-2512": { maxOutputTokens: 4096, contextWindow: 131072, thinkingType: "none" },
  "mistralai/ministral-8b-2512": { maxOutputTokens: 4096, contextWindow: 262144, thinkingType: "none" },
  "mistralai/mistral-7b-instruct-v0.1": { maxOutputTokens: 2824, contextWindow: 4096, thinkingType: "none" },
  "mistralai/mistral-large": { maxOutputTokens: 4096, contextWindow: 128000, thinkingType: "none" },
  "mistralai/mistral-large-2407": { maxOutputTokens: 4096, contextWindow: 131072, thinkingType: "none" },
  "mistralai/mistral-large-2411": { maxOutputTokens: 4096, contextWindow: 131072, thinkingType: "none" },
  "mistralai/mistral-large-2512": { maxOutputTokens: 4096, contextWindow: 262144, thinkingType: "none" },
  "mistralai/mistral-medium-3": { maxOutputTokens: 4096, contextWindow: 131072, thinkingType: "none" },
  "mistralai/mistral-medium-3-5": { maxOutputTokens: 4096, contextWindow: 262144, thinkingType: "none" },
  "mistralai/mistral-medium-3.1": { maxOutputTokens: 4096, contextWindow: 131072, thinkingType: "none" },
  "mistralai/mistral-nemo": { maxOutputTokens: 4096, contextWindow: 131072, thinkingType: "none" },
  "mistralai/mistral-saba": { maxOutputTokens: 4096, contextWindow: 32768, thinkingType: "none" },
  "mistralai/mistral-small-24b-instruct-2501": { maxOutputTokens: 16384, contextWindow: 32768, thinkingType: "none" },
  "mistralai/mistral-small-2603": { maxOutputTokens: 4096, contextWindow: 262144, thinkingType: "none" },
  "mistralai/mistral-small-3.1-24b-instruct": { maxOutputTokens: 128000, contextWindow: 128000, thinkingType: "none" },
  "mistralai/mistral-small-3.2-24b-instruct": { maxOutputTokens: 16384, contextWindow: 128000, thinkingType: "none" },
  "mistralai/mixtral-8x22b-instruct": { maxOutputTokens: 4096, contextWindow: 65536, thinkingType: "none" },
  "mistralai/pixtral-large-2411": { maxOutputTokens: 4096, contextWindow: 131072, thinkingType: "none" },
  "mistralai/voxtral-small-24b-2507": { maxOutputTokens: 4096, contextWindow: 32000, thinkingType: "none" },
  "mixtral-8x22b-instruct": { maxOutputTokens: 4096, contextWindow: 65536, thinkingType: "none" },
  "moonshot/kimi-2.6": { maxOutputTokens: 262142, contextWindow: 262144, thinkingType: "none" },
  "moonshot/kimi-k2": { maxOutputTokens: 32768, contextWindow: 131072, thinkingType: "none" },
  "moonshot/kimi-k2.5": { maxOutputTokens: 262144, contextWindow: 262144, thinkingType: "none" },
  "moonshot/kimi-k2.6": { maxOutputTokens: 262142, contextWindow: 262144, thinkingType: "none" },
  "moonshotai/kimi-k2": { maxOutputTokens: 32768, contextWindow: 131072, thinkingType: "none" },
  "moonshotai/kimi-k2-0905": { maxOutputTokens: 262144, contextWindow: 262144, thinkingType: "none" },
  "moonshotai/kimi-k2-thinking": { maxOutputTokens: 262144, contextWindow: 262144, thinkingType: "budget" },
  "moonshotai/kimi-k2.5": { maxOutputTokens: 262144, contextWindow: 262144, thinkingType: "none" },
  "moonshotai/kimi-k2.6": { maxOutputTokens: 262142, contextWindow: 262144, thinkingType: "none" },
  "morph-v3-fast": { maxOutputTokens: 38000, contextWindow: 81920, thinkingType: "none" },
  "morph-v3-large": { maxOutputTokens: 131072, contextWindow: 262144, thinkingType: "none" },
  "morph/morph-v3-fast": { maxOutputTokens: 38000, contextWindow: 81920, thinkingType: "none" },
  "morph/morph-v3-large": { maxOutputTokens: 131072, contextWindow: 262144, thinkingType: "none" },
  "mythomax-l2-13b": { maxOutputTokens: 4096, contextWindow: 4096, thinkingType: "none" },
  "nemotron-3-nano-30b-a3b": { maxOutputTokens: 228000, contextWindow: 262144, thinkingType: "none" },
  "nemotron-3-nano-30b-a3b:free": { maxOutputTokens: 4096, contextWindow: 256000, thinkingType: "none" },
  "nemotron-3-nano-omni-30b-a3b-reasoning:free": { maxOutputTokens: 65536, contextWindow: 256000, thinkingType: "none" },
  "nemotron-3-super-120b-a12b": { maxOutputTokens: 4096, contextWindow: 1000000, thinkingType: "none" },
  "nemotron-3-super-120b-a12b:free": { maxOutputTokens: 262144, contextWindow: 1000000, thinkingType: "none" },
  "nemotron-nano-12b-v2-vl:free": { maxOutputTokens: 128000, contextWindow: 128000, thinkingType: "none" },
  "nemotron-nano-9b-v2": { maxOutputTokens: 16384, contextWindow: 131072, thinkingType: "none" },
  "nemotron-nano-9b-v2:free": { maxOutputTokens: 4096, contextWindow: 128000, thinkingType: "none" },
  "nex-agi/deepseek-v3.1-nex-n1": { maxOutputTokens: 163840, contextWindow: 131072, thinkingType: "none" },
  "nousresearch/hermes-2-pro-llama-3-8b": { maxOutputTokens: 8192, contextWindow: 8192, thinkingType: "none" },
  "nousresearch/hermes-3-llama-3.1-405b": { maxOutputTokens: 16384, contextWindow: 131072, thinkingType: "none" },
  "nousresearch/hermes-3-llama-3.1-405b:free": { maxOutputTokens: 4096, contextWindow: 131072, thinkingType: "none" },
  "nousresearch/hermes-3-llama-3.1-70b": { maxOutputTokens: 16384, contextWindow: 131072, thinkingType: "none" },
  "nousresearch/hermes-4-405b": { maxOutputTokens: 4096, contextWindow: 131072, thinkingType: "none" },
  "nousresearch/hermes-4-70b": { maxOutputTokens: 4096, contextWindow: 131072, thinkingType: "none" },
  "nova-2-lite-v1": { maxOutputTokens: 65535, contextWindow: 1000000, thinkingType: "none" },
  "nova-lite-v1": { maxOutputTokens: 5120, contextWindow: 300000, thinkingType: "none" },
  "nova-micro-v1": { maxOutputTokens: 5120, contextWindow: 128000, thinkingType: "none" },
  "nova-premier-v1": { maxOutputTokens: 32000, contextWindow: 1000000, thinkingType: "none" },
  "nova-pro-v1": { maxOutputTokens: 5120, contextWindow: 300000, thinkingType: "none" },
  "nvidia/llama-3.3-nemotron-super-49b-v1.5": { maxOutputTokens: 16384, contextWindow: 131072, thinkingType: "none" },
  "nvidia/nemotron-3-nano-30b-a3b": { maxOutputTokens: 228000, contextWindow: 262144, thinkingType: "none" },
  "nvidia/nemotron-3-nano-30b-a3b:free": { maxOutputTokens: 4096, contextWindow: 256000, thinkingType: "none" },
  "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free": { maxOutputTokens: 65536, contextWindow: 256000, thinkingType: "none" },
  "nvidia/nemotron-3-super-120b-a12b": { maxOutputTokens: 4096, contextWindow: 1000000, thinkingType: "none" },
  "nvidia/nemotron-3-super-120b-a12b:free": { maxOutputTokens: 262144, contextWindow: 1000000, thinkingType: "none" },
  "nvidia/nemotron-nano-12b-v2-vl:free": { maxOutputTokens: 128000, contextWindow: 128000, thinkingType: "none" },
  "nvidia/nemotron-nano-9b-v2": { maxOutputTokens: 16384, contextWindow: 131072, thinkingType: "none" },
  "nvidia/nemotron-nano-9b-v2:free": { maxOutputTokens: 4096, contextWindow: 128000, thinkingType: "none" },
  "o1": { maxOutputTokens: 100000, contextWindow: 200000, thinkingType: "effort", effortLevels: ["low","medium","high"] },
  "o1-mini": { maxOutputTokens: 65536, contextWindow: 128000, thinkingType: "effort", effortLevels: ["low","medium","high"] },
  "o1-preview": { maxOutputTokens: 32768, contextWindow: 128000, thinkingType: "effort", effortLevels: ["low","medium","high"] },
  "o1-pro": { maxOutputTokens: 100000, contextWindow: 200000, thinkingType: "effort", effortLevels: ["low","medium","high"] },
  "o3": { maxOutputTokens: 100000, contextWindow: 200000, thinkingType: "effort", effortLevels: ["low","medium","high"] },
  "o3-deep-research": { maxOutputTokens: 100000, contextWindow: 200000, thinkingType: "effort", effortLevels: ["low","medium","high"] },
  "o3-mini": { maxOutputTokens: 100000, contextWindow: 200000, thinkingType: "effort", effortLevels: ["low","medium","high"] },
  "o3-mini-high": { maxOutputTokens: 100000, contextWindow: 200000, thinkingType: "effort", effortLevels: ["low","medium","high"] },
  "o3-pro": { maxOutputTokens: 100000, contextWindow: 200000, thinkingType: "effort", effortLevels: ["low","medium","high"] },
  "o4-mini": { maxOutputTokens: 100000, contextWindow: 200000, thinkingType: "effort", effortLevels: ["low","medium","high"] },
  "o4-mini-deep-research": { maxOutputTokens: 100000, contextWindow: 200000, thinkingType: "effort", effortLevels: ["low","medium","high"] },
  "o4-mini-high": { maxOutputTokens: 100000, contextWindow: 200000, thinkingType: "effort", effortLevels: ["low","medium","high"] },
  "olmo-3-32b-think": { maxOutputTokens: 65536, contextWindow: 65536, thinkingType: "none" },
  "openai/gpt-3.5-turbo": { maxOutputTokens: 4096, contextWindow: 16385, thinkingType: "none" },
  "openai/gpt-3.5-turbo-0613": { maxOutputTokens: 4096, contextWindow: 4095, thinkingType: "none" },
  "openai/gpt-3.5-turbo-16k": { maxOutputTokens: 4096, contextWindow: 16385, thinkingType: "none" },
  "openai/gpt-3.5-turbo-instruct": { maxOutputTokens: 4096, contextWindow: 4095, thinkingType: "none" },
  "openai/gpt-4": { maxOutputTokens: 4096, contextWindow: 8192, thinkingType: "none" },
  "openai/gpt-4-0314": { maxOutputTokens: 4096, contextWindow: 8191, thinkingType: "none" },
  "openai/gpt-4-1106-preview": { maxOutputTokens: 4096, contextWindow: 128000, thinkingType: "none" },
  "openai/gpt-4-turbo": { maxOutputTokens: 4096, contextWindow: 128000, thinkingType: "none" },
  "openai/gpt-4-turbo-preview": { maxOutputTokens: 4096, contextWindow: 128000, thinkingType: "none" },
  "openai/gpt-4.1": { maxOutputTokens: 4096, contextWindow: 1047576, thinkingType: "none" },
  "openai/gpt-4.1-mini": { maxOutputTokens: 32768, contextWindow: 1047576, thinkingType: "none" },
  "openai/gpt-4.1-nano": { maxOutputTokens: 32768, contextWindow: 1047576, thinkingType: "none" },
  "openai/gpt-4.5": { maxOutputTokens: 16384, contextWindow: 128000, thinkingType: "none" },
  "openai/gpt-4.5-preview": { maxOutputTokens: 16384, contextWindow: 128000, thinkingType: "none" },
  "openai/gpt-4o": { maxOutputTokens: 16384, contextWindow: 128000, thinkingType: "none" },
  "openai/gpt-4o-2024-05-13": { maxOutputTokens: 4096, contextWindow: 128000, thinkingType: "none" },
  "openai/gpt-4o-2024-08-06": { maxOutputTokens: 16384, contextWindow: 128000, thinkingType: "none" },
  "openai/gpt-4o-2024-11-20": { maxOutputTokens: 16384, contextWindow: 128000, thinkingType: "none" },
  "openai/gpt-4o-audio-preview": { maxOutputTokens: 16384, contextWindow: 128000, thinkingType: "none" },
  "openai/gpt-4o-mini": { maxOutputTokens: 16384, contextWindow: 128000, thinkingType: "none" },
  "openai/gpt-4o-mini-2024-07-18": { maxOutputTokens: 16384, contextWindow: 128000, thinkingType: "none" },
  "openai/gpt-4o-mini-search-preview": { maxOutputTokens: 16384, contextWindow: 128000, thinkingType: "none" },
  "openai/gpt-4o-search-preview": { maxOutputTokens: 16384, contextWindow: 128000, thinkingType: "none" },
  "openai/gpt-5": { maxOutputTokens: 128000, contextWindow: 400000, thinkingType: "none" },
  "openai/gpt-5-chat": { maxOutputTokens: 16384, contextWindow: 128000, thinkingType: "none" },
  "openai/gpt-5-codex": { maxOutputTokens: 128000, contextWindow: 400000, thinkingType: "none" },
  "openai/gpt-5-image": { maxOutputTokens: 128000, contextWindow: 400000, thinkingType: "none" },
  "openai/gpt-5-image-mini": { maxOutputTokens: 128000, contextWindow: 400000, thinkingType: "none" },
  "openai/gpt-5-mini": { maxOutputTokens: 128000, contextWindow: 400000, thinkingType: "none" },
  "openai/gpt-5-nano": { maxOutputTokens: 4096, contextWindow: 400000, thinkingType: "none" },
  "openai/gpt-5-pro": { maxOutputTokens: 128000, contextWindow: 400000, thinkingType: "none" },
  "openai/gpt-5.1": { maxOutputTokens: 128000, contextWindow: 400000, thinkingType: "none" },
  "openai/gpt-5.1-chat": { maxOutputTokens: 16384, contextWindow: 128000, thinkingType: "none" },
  "openai/gpt-5.1-codex": { maxOutputTokens: 128000, contextWindow: 400000, thinkingType: "none" },
  "openai/gpt-5.1-codex-max": { maxOutputTokens: 128000, contextWindow: 400000, thinkingType: "none" },
  "openai/gpt-5.1-codex-mini": { maxOutputTokens: 128000, contextWindow: 400000, thinkingType: "none" },
  "openai/gpt-5.2": { maxOutputTokens: 128000, contextWindow: 400000, thinkingType: "none" },
  "openai/gpt-5.2-chat": { maxOutputTokens: 32000, contextWindow: 128000, thinkingType: "none" },
  "openai/gpt-5.2-codex": { maxOutputTokens: 128000, contextWindow: 400000, thinkingType: "none" },
  "openai/gpt-5.2-pro": { maxOutputTokens: 128000, contextWindow: 400000, thinkingType: "none" },
  "openai/gpt-5.3-chat": { maxOutputTokens: 16384, contextWindow: 128000, thinkingType: "none" },
  "openai/gpt-5.3-codex": { maxOutputTokens: 128000, contextWindow: 400000, thinkingType: "none" },
  "openai/gpt-5.4": { maxOutputTokens: 128000, contextWindow: 1050000, thinkingType: "none" },
  "openai/gpt-5.4-image-2": { maxOutputTokens: 128000, contextWindow: 272000, thinkingType: "none" },
  "openai/gpt-5.4-mini": { maxOutputTokens: 128000, contextWindow: 400000, thinkingType: "none" },
  "openai/gpt-5.4-nano": { maxOutputTokens: 128000, contextWindow: 400000, thinkingType: "none" },
  "openai/gpt-5.4-pro": { maxOutputTokens: 128000, contextWindow: 1050000, thinkingType: "none" },
  "openai/gpt-5.5": { maxOutputTokens: 128000, contextWindow: 1050000, thinkingType: "none" },
  "openai/gpt-5.5-pro": { maxOutputTokens: 128000, contextWindow: 1050000, thinkingType: "none" },
  "openai/gpt-audio": { maxOutputTokens: 16384, contextWindow: 128000, thinkingType: "none" },
  "openai/gpt-audio-mini": { maxOutputTokens: 16384, contextWindow: 128000, thinkingType: "none" },
  "openai/gpt-chat-latest": { maxOutputTokens: 128000, contextWindow: 400000, thinkingType: "none" },
  "openai/gpt-oss-120b": { maxOutputTokens: 4096, contextWindow: 131072, thinkingType: "none" },
  "openai/gpt-oss-120b:free": { maxOutputTokens: 131072, contextWindow: 131072, thinkingType: "none" },
  "openai/gpt-oss-20b": { maxOutputTokens: 131072, contextWindow: 131072, thinkingType: "none" },
  "openai/gpt-oss-20b:free": { maxOutputTokens: 8192, contextWindow: 131072, thinkingType: "none" },
  "openai/gpt-oss-safeguard-20b": { maxOutputTokens: 65536, contextWindow: 131072, thinkingType: "none" },
  "openai/o1": { maxOutputTokens: 100000, contextWindow: 200000, thinkingType: "effort", effortLevels: ["low","medium","high"] },
  "openai/o1-mini": { maxOutputTokens: 65536, contextWindow: 128000, thinkingType: "effort", effortLevels: ["low","medium","high"] },
  "openai/o1-preview": { maxOutputTokens: 32768, contextWindow: 128000, thinkingType: "effort", effortLevels: ["low","medium","high"] },
  "openai/o1-pro": { maxOutputTokens: 100000, contextWindow: 200000, thinkingType: "effort", effortLevels: ["low","medium","high"] },
  "openai/o3": { maxOutputTokens: 100000, contextWindow: 200000, thinkingType: "effort", effortLevels: ["low","medium","high"] },
  "openai/o3-deep-research": { maxOutputTokens: 100000, contextWindow: 200000, thinkingType: "effort", effortLevels: ["low","medium","high"] },
  "openai/o3-mini": { maxOutputTokens: 100000, contextWindow: 200000, thinkingType: "effort", effortLevels: ["low","medium","high"] },
  "openai/o3-mini-high": { maxOutputTokens: 100000, contextWindow: 200000, thinkingType: "effort", effortLevels: ["low","medium","high"] },
  "openai/o3-pro": { maxOutputTokens: 100000, contextWindow: 200000, thinkingType: "effort", effortLevels: ["low","medium","high"] },
  "openai/o4-mini": { maxOutputTokens: 100000, contextWindow: 200000, thinkingType: "effort", effortLevels: ["low","medium","high"] },
  "openai/o4-mini-deep-research": { maxOutputTokens: 100000, contextWindow: 200000, thinkingType: "effort", effortLevels: ["low","medium","high"] },
  "openai/o4-mini-high": { maxOutputTokens: 100000, contextWindow: 200000, thinkingType: "effort", effortLevels: ["low","medium","high"] },
  "openrouter/auto": { maxOutputTokens: 4096, contextWindow: 2000000, thinkingType: "none" },
  "openrouter/bodybuilder": { maxOutputTokens: 4096, contextWindow: 128000, thinkingType: "none" },
  "openrouter/free": { maxOutputTokens: 4096, contextWindow: 200000, thinkingType: "none" },
  "openrouter/owl-alpha": { maxOutputTokens: 262144, contextWindow: 1048756, thinkingType: "none" },
  "openrouter/pareto-code": { maxOutputTokens: 4096, contextWindow: 2000000, thinkingType: "none" },
  "owl-alpha": { maxOutputTokens: 262144, contextWindow: 1048756, thinkingType: "none" },
  "palmyra-x5": { maxOutputTokens: 8192, contextWindow: 1040000, thinkingType: "none" },
  "pareto-code": { maxOutputTokens: 4096, contextWindow: 2000000, thinkingType: "none" },
  "perceptron-mk1": { maxOutputTokens: 8192, contextWindow: 32768, thinkingType: "none" },
  "perceptron/perceptron-mk1": { maxOutputTokens: 8192, contextWindow: 32768, thinkingType: "none" },
  "perplexity/sonar": { maxOutputTokens: 4096, contextWindow: 127072, thinkingType: "none" },
  "perplexity/sonar-deep-research": { maxOutputTokens: 4096, contextWindow: 128000, thinkingType: "none" },
  "perplexity/sonar-pro": { maxOutputTokens: 8000, contextWindow: 200000, thinkingType: "none" },
  "perplexity/sonar-pro-search": { maxOutputTokens: 8000, contextWindow: 200000, thinkingType: "none" },
  "perplexity/sonar-reasoning-pro": { maxOutputTokens: 4096, contextWindow: 128000, thinkingType: "none" },
  "phi-4": { maxOutputTokens: 16384, contextWindow: 16384, thinkingType: "none" },
  "phi-4-mini-instruct": { maxOutputTokens: 128000, contextWindow: 131072, thinkingType: "none" },
  "pixtral-large-2411": { maxOutputTokens: 4096, contextWindow: 131072, thinkingType: "none" },
  "poolside/laguna-m.1:free": { maxOutputTokens: 32768, contextWindow: 262144, thinkingType: "none" },
  "poolside/laguna-xs.2:free": { maxOutputTokens: 8192, contextWindow: 131072, thinkingType: "none" },
  "prime-intellect/intellect-3": { maxOutputTokens: 131072, contextWindow: 131072, thinkingType: "none" },
  "qianfan-ocr-fast": { maxOutputTokens: 28672, contextWindow: 65536, thinkingType: "none" },
  "qwen-2.5-72b-instruct": { maxOutputTokens: 16384, contextWindow: 131072, thinkingType: "none" },
  "qwen-2.5-7b-instruct": { maxOutputTokens: 32768, contextWindow: 131072, thinkingType: "none" },
  "qwen-2.5-coder-32b-instruct": { maxOutputTokens: 32768, contextWindow: 128000, thinkingType: "none" },
  "qwen-plus": { maxOutputTokens: 32768, contextWindow: 1000000, thinkingType: "none" },
  "qwen-plus-2025-07-28": { maxOutputTokens: 32768, contextWindow: 1000000, thinkingType: "none" },
  "qwen-plus-2025-07-28:thinking": { maxOutputTokens: 32768, contextWindow: 1000000, thinkingType: "budget" },
  "qwen/qwen-2.5-72b-instruct": { maxOutputTokens: 16384, contextWindow: 131072, thinkingType: "none" },
  "qwen/qwen-2.5-7b-instruct": { maxOutputTokens: 32768, contextWindow: 131072, thinkingType: "none" },
  "qwen/qwen-2.5-coder-32b-instruct": { maxOutputTokens: 32768, contextWindow: 128000, thinkingType: "none" },
  "qwen/qwen-plus": { maxOutputTokens: 32768, contextWindow: 1000000, thinkingType: "none" },
  "qwen/qwen-plus-2025-07-28": { maxOutputTokens: 32768, contextWindow: 1000000, thinkingType: "none" },
  "qwen/qwen-plus-2025-07-28:thinking": { maxOutputTokens: 32768, contextWindow: 1000000, thinkingType: "budget" },
  "qwen/qwen2.5-vl-72b-instruct": { maxOutputTokens: 4096, contextWindow: 131072, thinkingType: "none" },
  "qwen/qwen3-14b": { maxOutputTokens: 40960, contextWindow: 131702, thinkingType: "none" },
  "qwen/qwen3-235b-a22b": { maxOutputTokens: 8192, contextWindow: 131072, thinkingType: "none" },
  "qwen/qwen3-235b-a22b-2507": { maxOutputTokens: 16384, contextWindow: 262144, thinkingType: "none" },
  "qwen/qwen3-235b-a22b-thinking-2507": { maxOutputTokens: 4096, contextWindow: 262144, thinkingType: "budget" },
  "qwen/qwen3-30b-a3b": { maxOutputTokens: 20000, contextWindow: 131072, thinkingType: "none" },
  "qwen/qwen3-30b-a3b-instruct-2507": { maxOutputTokens: 262144, contextWindow: 262144, thinkingType: "none" },
  "qwen/qwen3-30b-a3b-thinking-2507": { maxOutputTokens: 131072, contextWindow: 131072, thinkingType: "budget" },
  "qwen/qwen3-32b": { maxOutputTokens: 16384, contextWindow: 131072, thinkingType: "none" },
  "qwen/qwen3-8b": { maxOutputTokens: 8192, contextWindow: 131072, thinkingType: "none" },
  "qwen/qwen3-coder": { maxOutputTokens: 65536, contextWindow: 1048576, thinkingType: "none" },
  "qwen/qwen3-coder-30b-a3b-instruct": { maxOutputTokens: 32768, contextWindow: 160000, thinkingType: "none" },
  "qwen/qwen3-coder-flash": { maxOutputTokens: 65536, contextWindow: 1000000, thinkingType: "none" },
  "qwen/qwen3-coder-next": { maxOutputTokens: 262144, contextWindow: 262144, thinkingType: "none" },
  "qwen/qwen3-coder-plus": { maxOutputTokens: 65536, contextWindow: 1000000, thinkingType: "none" },
  "qwen/qwen3-coder:free": { maxOutputTokens: 262000, contextWindow: 1048576, thinkingType: "none" },
  "qwen/qwen3-max": { maxOutputTokens: 32768, contextWindow: 262144, thinkingType: "none" },
  "qwen/qwen3-max-thinking": { maxOutputTokens: 32768, contextWindow: 262144, thinkingType: "budget" },
  "qwen/qwen3-next-80b-a3b-instruct": { maxOutputTokens: 16384, contextWindow: 262144, thinkingType: "none" },
  "qwen/qwen3-next-80b-a3b-instruct:free": { maxOutputTokens: 4096, contextWindow: 262144, thinkingType: "none" },
  "qwen/qwen3-next-80b-a3b-thinking": { maxOutputTokens: 32768, contextWindow: 262144, thinkingType: "budget" },
  "qwen/qwen3-vl-235b-a22b-instruct": { maxOutputTokens: 16384, contextWindow: 262144, thinkingType: "none" },
  "qwen/qwen3-vl-235b-a22b-thinking": { maxOutputTokens: 32768, contextWindow: 131072, thinkingType: "budget" },
  "qwen/qwen3-vl-30b-a3b-instruct": { maxOutputTokens: 32768, contextWindow: 262144, thinkingType: "none" },
  "qwen/qwen3-vl-30b-a3b-thinking": { maxOutputTokens: 32768, contextWindow: 131072, thinkingType: "budget" },
  "qwen/qwen3-vl-32b-instruct": { maxOutputTokens: 32768, contextWindow: 262144, thinkingType: "none" },
  "qwen/qwen3-vl-8b-instruct": { maxOutputTokens: 32768, contextWindow: 256000, thinkingType: "none" },
  "qwen/qwen3-vl-8b-thinking": { maxOutputTokens: 32768, contextWindow: 256000, thinkingType: "budget" },
  "qwen/qwen3.5-122b-a10b": { maxOutputTokens: 262144, contextWindow: 262144, thinkingType: "none" },
  "qwen/qwen3.5-27b": { maxOutputTokens: 65536, contextWindow: 262144, thinkingType: "none" },
  "qwen/qwen3.5-35b-a3b": { maxOutputTokens: 4096, contextWindow: 262144, thinkingType: "none" },
  "qwen/qwen3.5-397b-a17b": { maxOutputTokens: 65536, contextWindow: 262144, thinkingType: "none" },
  "qwen/qwen3.5-9b": { maxOutputTokens: 81920, contextWindow: 262144, thinkingType: "none" },
  "qwen/qwen3.5-flash": { maxOutputTokens: 65536, contextWindow: 1000000, thinkingType: "none" },
  "qwen/qwen3.5-flash-02-23": { maxOutputTokens: 65536, contextWindow: 1000000, thinkingType: "none" },
  "qwen/qwen3.5-plus-02-15": { maxOutputTokens: 65536, contextWindow: 1000000, thinkingType: "none" },
  "qwen/qwen3.5-plus-20260420": { maxOutputTokens: 65536, contextWindow: 1000000, thinkingType: "none" },
  "qwen/qwen3.6-27b": { maxOutputTokens: 65536, contextWindow: 262144, thinkingType: "none" },
  "qwen/qwen3.6-35b-a3b": { maxOutputTokens: 262140, contextWindow: 262144, thinkingType: "none" },
  "qwen/qwen3.6-flash": { maxOutputTokens: 65536, contextWindow: 1000000, thinkingType: "none" },
  "qwen/qwen3.6-max-preview": { maxOutputTokens: 65536, contextWindow: 262144, thinkingType: "none" },
  "qwen/qwen3.6-plus": { maxOutputTokens: 65536, contextWindow: 1000000, thinkingType: "none" },
  "qwen/qwen3.7-max": { maxOutputTokens: 65536, contextWindow: 1000000, thinkingType: "none" },
  "qwen2.5-vl-72b-instruct": { maxOutputTokens: 4096, contextWindow: 131072, thinkingType: "none" },
  "qwen3-14b": { maxOutputTokens: 40960, contextWindow: 131702, thinkingType: "none" },
  "qwen3-235b-a22b": { maxOutputTokens: 8192, contextWindow: 131072, thinkingType: "none" },
  "qwen3-235b-a22b-2507": { maxOutputTokens: 16384, contextWindow: 262144, thinkingType: "none" },
  "qwen3-235b-a22b-thinking-2507": { maxOutputTokens: 4096, contextWindow: 262144, thinkingType: "budget" },
  "qwen3-30b-a3b": { maxOutputTokens: 20000, contextWindow: 131072, thinkingType: "none" },
  "qwen3-30b-a3b-instruct-2507": { maxOutputTokens: 262144, contextWindow: 262144, thinkingType: "none" },
  "qwen3-30b-a3b-thinking-2507": { maxOutputTokens: 131072, contextWindow: 131072, thinkingType: "budget" },
  "qwen3-32b": { maxOutputTokens: 16384, contextWindow: 131072, thinkingType: "none" },
  "qwen3-8b": { maxOutputTokens: 8192, contextWindow: 131072, thinkingType: "none" },
  "qwen3-coder": { maxOutputTokens: 65536, contextWindow: 1048576, thinkingType: "none" },
  "qwen3-coder-30b-a3b-instruct": { maxOutputTokens: 32768, contextWindow: 160000, thinkingType: "none" },
  "qwen3-coder-flash": { maxOutputTokens: 65536, contextWindow: 1000000, thinkingType: "none" },
  "qwen3-coder-next": { maxOutputTokens: 262144, contextWindow: 262144, thinkingType: "none" },
  "qwen3-coder-plus": { maxOutputTokens: 65536, contextWindow: 1000000, thinkingType: "none" },
  "qwen3-coder:free": { maxOutputTokens: 262000, contextWindow: 1048576, thinkingType: "none" },
  "qwen3-max": { maxOutputTokens: 32768, contextWindow: 262144, thinkingType: "none" },
  "qwen3-max-thinking": { maxOutputTokens: 32768, contextWindow: 262144, thinkingType: "budget" },
  "qwen3-next-80b-a3b-instruct": { maxOutputTokens: 16384, contextWindow: 262144, thinkingType: "none" },
  "qwen3-next-80b-a3b-instruct:free": { maxOutputTokens: 4096, contextWindow: 262144, thinkingType: "none" },
  "qwen3-next-80b-a3b-thinking": { maxOutputTokens: 32768, contextWindow: 262144, thinkingType: "budget" },
  "qwen3-vl-235b-a22b-instruct": { maxOutputTokens: 16384, contextWindow: 262144, thinkingType: "none" },
  "qwen3-vl-235b-a22b-thinking": { maxOutputTokens: 32768, contextWindow: 131072, thinkingType: "budget" },
  "qwen3-vl-30b-a3b-instruct": { maxOutputTokens: 32768, contextWindow: 262144, thinkingType: "none" },
  "qwen3-vl-30b-a3b-thinking": { maxOutputTokens: 32768, contextWindow: 131072, thinkingType: "budget" },
  "qwen3-vl-32b-instruct": { maxOutputTokens: 32768, contextWindow: 262144, thinkingType: "none" },
  "qwen3-vl-8b-instruct": { maxOutputTokens: 32768, contextWindow: 256000, thinkingType: "none" },
  "qwen3-vl-8b-thinking": { maxOutputTokens: 32768, contextWindow: 256000, thinkingType: "budget" },
  "qwen3.5-122b-a10b": { maxOutputTokens: 262144, contextWindow: 262144, thinkingType: "none" },
  "qwen3.5-27b": { maxOutputTokens: 65536, contextWindow: 262144, thinkingType: "none" },
  "qwen3.5-35b-a3b": { maxOutputTokens: 4096, contextWindow: 262144, thinkingType: "none" },
  "qwen3.5-397b-a17b": { maxOutputTokens: 65536, contextWindow: 262144, thinkingType: "none" },
  "qwen3.5-9b": { maxOutputTokens: 81920, contextWindow: 262144, thinkingType: "none" },
  "qwen3.5-flash": { maxOutputTokens: 65536, contextWindow: 1000000, thinkingType: "none" },
  "qwen3.5-flash-02-23": { maxOutputTokens: 65536, contextWindow: 1000000, thinkingType: "none" },
  "qwen3.5-plus-02-15": { maxOutputTokens: 65536, contextWindow: 1000000, thinkingType: "none" },
  "qwen3.5-plus-20260420": { maxOutputTokens: 65536, contextWindow: 1000000, thinkingType: "none" },
  "qwen3.6-27b": { maxOutputTokens: 65536, contextWindow: 262144, thinkingType: "none" },
  "qwen3.6-35b-a3b": { maxOutputTokens: 262140, contextWindow: 262144, thinkingType: "none" },
  "qwen3.6-flash": { maxOutputTokens: 65536, contextWindow: 1000000, thinkingType: "none" },
  "qwen3.6-max-preview": { maxOutputTokens: 65536, contextWindow: 262144, thinkingType: "none" },
  "qwen3.6-plus": { maxOutputTokens: 65536, contextWindow: 1000000, thinkingType: "none" },
  "qwen3.7-max": { maxOutputTokens: 65536, contextWindow: 1000000, thinkingType: "none" },
  "reka-edge": { maxOutputTokens: 16384, contextWindow: 16384, thinkingType: "none" },
  "reka-flash-3": { maxOutputTokens: 65536, contextWindow: 65536, thinkingType: "none" },
  "rekaai/reka-edge": { maxOutputTokens: 16384, contextWindow: 16384, thinkingType: "none" },
  "rekaai/reka-flash-3": { maxOutputTokens: 65536, contextWindow: 65536, thinkingType: "none" },
  "relace-apply-3": { maxOutputTokens: 128000, contextWindow: 256000, thinkingType: "none" },
  "relace-search": { maxOutputTokens: 128000, contextWindow: 256000, thinkingType: "none" },
  "relace/relace-apply-3": { maxOutputTokens: 128000, contextWindow: 256000, thinkingType: "none" },
  "relace/relace-search": { maxOutputTokens: 128000, contextWindow: 256000, thinkingType: "none" },
  "remm-slerp-l2-13b": { maxOutputTokens: 4096, contextWindow: 6144, thinkingType: "none" },
  "ring-2.6-1t": { maxOutputTokens: 65536, contextWindow: 262144, thinkingType: "none" },
  "rnj-1-instruct": { maxOutputTokens: 4096, contextWindow: 32768, thinkingType: "none" },
  "rocinante-12b": { maxOutputTokens: 32768, contextWindow: 32768, thinkingType: "none" },
  "router": { maxOutputTokens: 4096, contextWindow: 131072, thinkingType: "none" },
  "sao10k/l3-euryale-70b": { maxOutputTokens: 8192, contextWindow: 8192, thinkingType: "effort", effortLevels: ["low","medium","high"] },
  "sao10k/l3-lunaris-8b": { maxOutputTokens: 16384, contextWindow: 8192, thinkingType: "effort", effortLevels: ["low","medium","high"] },
  "sao10k/l3.1-70b-hanami-x1": { maxOutputTokens: 100000, contextWindow: 16000, thinkingType: "effort", effortLevels: ["low","medium","high"] },
  "sao10k/l3.1-euryale-70b": { maxOutputTokens: 16384, contextWindow: 131072, thinkingType: "effort", effortLevels: ["low","medium","high"] },
  "sao10k/l3.3-euryale-70b": { maxOutputTokens: 16384, contextWindow: 131072, thinkingType: "effort", effortLevels: ["low","medium","high"] },
  "seed-1.6": { maxOutputTokens: 32768, contextWindow: 262144, thinkingType: "none" },
  "seed-1.6-flash": { maxOutputTokens: 32768, contextWindow: 262144, thinkingType: "none" },
  "seed-2.0-lite": { maxOutputTokens: 131072, contextWindow: 262144, thinkingType: "none" },
  "seed-2.0-mini": { maxOutputTokens: 131072, contextWindow: 262144, thinkingType: "none" },
  "skyfall-36b-v2": { maxOutputTokens: 32768, contextWindow: 32768, thinkingType: "none" },
  "solar-pro-3": { maxOutputTokens: 4096, contextWindow: 128000, thinkingType: "none" },
  "sonar": { maxOutputTokens: 4096, contextWindow: 127072, thinkingType: "none" },
  "sonar-deep-research": { maxOutputTokens: 4096, contextWindow: 128000, thinkingType: "none" },
  "sonar-pro": { maxOutputTokens: 8000, contextWindow: 200000, thinkingType: "none" },
  "sonar-pro-search": { maxOutputTokens: 8000, contextWindow: 200000, thinkingType: "none" },
  "sonar-reasoning-pro": { maxOutputTokens: 4096, contextWindow: 128000, thinkingType: "none" },
  "spotlight": { maxOutputTokens: 65537, contextWindow: 131072, thinkingType: "none" },
  "step-3.5-flash": { maxOutputTokens: 16384, contextWindow: 262144, thinkingType: "none" },
  "stepfun/step-3.5-flash": { maxOutputTokens: 16384, contextWindow: 262144, thinkingType: "none" },
  "switchpoint/router": { maxOutputTokens: 4096, contextWindow: 131072, thinkingType: "none" },
  "tencent/hunyuan-a13b-instruct": { maxOutputTokens: 131072, contextWindow: 131072, thinkingType: "none" },
  "tencent/hy3-preview": { maxOutputTokens: 262144, contextWindow: 262144, thinkingType: "none" },
  "thedrummer/cydonia-24b-v4.1": { maxOutputTokens: 131072, contextWindow: 131072, thinkingType: "none" },
  "thedrummer/rocinante-12b": { maxOutputTokens: 32768, contextWindow: 32768, thinkingType: "none" },
  "thedrummer/skyfall-36b-v2": { maxOutputTokens: 32768, contextWindow: 32768, thinkingType: "none" },
  "thedrummer/unslopnemo-12b": { maxOutputTokens: 32768, contextWindow: 32768, thinkingType: "none" },
  "trinity-large-thinking": { maxOutputTokens: 262144, contextWindow: 262144, thinkingType: "budget" },
  "trinity-mini": { maxOutputTokens: 131072, contextWindow: 131072, thinkingType: "none" },
  "ui-tars-1.5-7b": { maxOutputTokens: 2048, contextWindow: 128000, thinkingType: "none" },
  "undi95/remm-slerp-l2-13b": { maxOutputTokens: 4096, contextWindow: 6144, thinkingType: "none" },
  "unslopnemo-12b": { maxOutputTokens: 32768, contextWindow: 32768, thinkingType: "none" },
  "upstage/solar-pro-3": { maxOutputTokens: 4096, contextWindow: 128000, thinkingType: "none" },
  "virtuoso-large": { maxOutputTokens: 64000, contextWindow: 131072, thinkingType: "none" },
  "voxtral-small-24b-2507": { maxOutputTokens: 4096, contextWindow: 32000, thinkingType: "none" },
  "weaver": { maxOutputTokens: 2000, contextWindow: 8000, thinkingType: "none" },
  "wizardlm-2-8x22b": { maxOutputTokens: 8000, contextWindow: 65536, thinkingType: "none" },
  "writer/palmyra-x5": { maxOutputTokens: 8192, contextWindow: 1040000, thinkingType: "none" },
  "x-ai/grok-4.20": { maxOutputTokens: 4096, contextWindow: 2000000, thinkingType: "none" },
  "x-ai/grok-4.20-multi-agent": { maxOutputTokens: 4096, contextWindow: 2000000, thinkingType: "none" },
  "x-ai/grok-4.3": { maxOutputTokens: 4096, contextWindow: 1000000, thinkingType: "none" },
  "x-ai/grok-build-0.1": { maxOutputTokens: 4096, contextWindow: 256000, thinkingType: "none" },
  "xiaomi/mimo-v2-flash": { maxOutputTokens: 65536, contextWindow: 262144, thinkingType: "none" },
  "xiaomi/mimo-v2-omni": { maxOutputTokens: 65536, contextWindow: 262144, thinkingType: "none" },
  "xiaomi/mimo-v2-pro": { maxOutputTokens: 131072, contextWindow: 1048576, thinkingType: "none" },
  "xiaomi/mimo-v2.5": { maxOutputTokens: 131072, contextWindow: 1048576, thinkingType: "none" },
  "xiaomi/mimo-v2.5-pro": { maxOutputTokens: 131072, contextWindow: 1048576, thinkingType: "none" },
  "z-ai/glm-4": { maxOutputTokens: 4096, contextWindow: 128000, thinkingType: "none" },
  "z-ai/glm-4-32b": { maxOutputTokens: 4096, contextWindow: 128000, thinkingType: "none" },
  "z-ai/glm-4-plus": { maxOutputTokens: 8192, contextWindow: 128000, thinkingType: "none" },
  "z-ai/glm-4.5": { maxOutputTokens: 98304, contextWindow: 131072, thinkingType: "none" },
  "z-ai/glm-4.5-air": { maxOutputTokens: 98304, contextWindow: 131072, thinkingType: "none" },
  "z-ai/glm-4.5-air:free": { maxOutputTokens: 96000, contextWindow: 131072, thinkingType: "none" },
  "z-ai/glm-4.5v": { maxOutputTokens: 16384, contextWindow: 65536, thinkingType: "none" },
  "z-ai/glm-4.6": { maxOutputTokens: 131072, contextWindow: 202752, thinkingType: "none" },
  "z-ai/glm-4.6v": { maxOutputTokens: 24000, contextWindow: 131072, thinkingType: "none" },
  "z-ai/glm-4.7": { maxOutputTokens: 131072, contextWindow: 202752, thinkingType: "none" },
  "z-ai/glm-4.7-flash": { maxOutputTokens: 16384, contextWindow: 202752, thinkingType: "none" },
  "z-ai/glm-5": { maxOutputTokens: 131072, contextWindow: 202752, thinkingType: "none" },
  "z-ai/glm-5-turbo": { maxOutputTokens: 131072, contextWindow: 202752, thinkingType: "none" },
  "z-ai/glm-5.1": { maxOutputTokens: 131072, contextWindow: 202752, thinkingType: "none" },
  "z-ai/glm-5v-turbo": { maxOutputTokens: 131072, contextWindow: 202752, thinkingType: "none" },
  "~anthropic/claude-haiku-latest": { maxOutputTokens: 64000, contextWindow: 200000, thinkingType: "none" },
  "~anthropic/claude-opus-latest": { maxOutputTokens: 128000, contextWindow: 1000000, thinkingType: "none" },
  "~anthropic/claude-sonnet-latest": { maxOutputTokens: 128000, contextWindow: 1000000, thinkingType: "none" },
  "~google/gemini-flash-latest": { maxOutputTokens: 65536, contextWindow: 1048576, thinkingType: "none" },
  "~google/gemini-pro-latest": { maxOutputTokens: 65536, contextWindow: 1048576, thinkingType: "none" },
  "~moonshotai/kimi-latest": { maxOutputTokens: 262142, contextWindow: 262144, thinkingType: "none" },
  "~openai/gpt-latest": { maxOutputTokens: 128000, contextWindow: 1050000, thinkingType: "none" },
  "~openai/gpt-mini-latest": { maxOutputTokens: 128000, contextWindow: 400000, thinkingType: "none" },
};

// ---- Spec Lookup ------------------------------------------------------------

/**
 * Fuzzy-match a model name to the registry.
 * Handles slash-prefixed names ("deepseek/deepseek-r1"),
 * version suffixes ("claude-3-7-sonnet-20250219"), etc.
 */
/** Precomputed registry keys for the shared {@link matchModelKey} matcher. */
const MODEL_REGISTRY_KEYS = Object.keys(MODEL_REGISTRY);

export function resolveModelSpec(model: string): ModelSpec | null {
  if (!model || typeof model !== "string") return null;

  // 0. User config override (highest priority).
  const override = getOverrideSpec(model);
  if (override) return override;

  // 1–4. exact → strip-prefix → longest-prefix → substring, via the matcher
  // shared with the catalog (one matching algorithm, not two).
  const key = matchModelKey(model, MODEL_REGISTRY_KEYS);
  if (key) return { ...MODEL_REGISTRY[key]! };

  return null;
}

/** Get the raw spec or a sensible default. */
/**
 * Enriches a resolved spec with the model catalog (models.json) when enabled.
 *  - Always adds `cost` + `capabilities` (the in-code chain never had them).
 *  - Only overrides limits when the base spec was a guess (heuristics/default),
 *    so a confident registry/override entry stays authoritative; the catalog
 *    just fills the gaps. Off by default → returns the spec untouched (legacy).
 */
function enrichWithCatalog(spec: ModelSpec, model: string, providerId?: string): ModelSpec {
  if (!isModelCatalogEnabled()) return spec;
  let cat = null as ReturnType<typeof getCatalogSpec>;
  try {
    cat = getCatalogSpec(model, providerId);
  } catch {
    cat = null;
  }
  if (!cat) return spec;

  const guessing = spec.specSource === "heuristics" || spec.specSource === "default";
  const out: ModelSpec = { ...spec };
  if (guessing) {
    if (typeof cat.contextWindow === "number") out.contextWindow = cat.contextWindow;
    if (typeof cat.maxOutputTokens === "number") out.maxOutputTokens = cat.maxOutputTokens;
    if (cat.contextWindow !== undefined || cat.maxOutputTokens !== undefined) {
      out.specSource = "catalog";
    }
  } else if (
    providerId &&
    typeof cat.contextWindow === "number" &&
    typeof out.contextWindow === "number" &&
    cat.contextWindow < out.contextWindow
  ) {
    // Provider-aware safety clamp: a confident (registry/override) window that
    // EXCEEDS the conservative cross-provider catalog bound is over-allocating
    // for this provider and risks overflow — e.g. the registry lists
    // minimax-m2.7 at 204800 but the NVIDIA API enforces 196608. The catalog
    // only ever TIGHTENS a confident spec here, never loosens it.
    out.contextWindow = cat.contextWindow;
    out.specSource = "catalog";
  }
  if (!out.cost && cat.cost) out.cost = cat.cost;
  if (!out.capabilities && cat.capabilities) out.capabilities = cat.capabilities;
  return out;
}

export function getModelSpec(model: string, providerId?: string): ModelSpec {
  if (!model || typeof model !== "string") {
    return {
      maxOutputTokens: 4096,
      contextWindow: 128_000,
      thinkingType: "none",
      specSource: "default",
    };
  }
  const resolved = resolveModelSpec(model);
  if (resolved) {
    const copy = { ...resolved };
    copy.specSource = copy.specSource ?? "registry";
    if (!copy.freeRateLimit) {
      if (model.toLowerCase().includes("gemini")) {
        copy.freeRateLimit = { rpm: 15, tpm: 1_000_000 };
      } else if (model.toLowerCase().includes("nvidia") || model.toLowerCase().includes("nim")) {
        copy.freeRateLimit = { rpm: 5, tpm: 200_000 };
      }
    }
    return enrichWithCatalog(copy, model, providerId);
  }

  // Heuristics fallback
  const heur = getHeuristicsSpec(model);
  if (heur) {
    const isNvidia = model.toLowerCase().includes("nvidia") || model.toLowerCase().includes("nim");
    const isGemini = model.toLowerCase().includes("gemini");
    return enrichWithCatalog(
      {
        ...heur,
        freeRateLimit: isNvidia
          ? { rpm: 5, tpm: 200_000 }
          : isGemini
            ? { rpm: 15, tpm: 1_000_000 }
            : undefined,
      },
      model,
      providerId
    );
  }

  const isNvidia = model.toLowerCase().includes("nvidia") || model.toLowerCase().includes("nim");
  const isGemini = model.toLowerCase().includes("gemini");
  return enrichWithCatalog(
    {
      maxOutputTokens: 4096,
      contextWindow: 128_000,
      thinkingType: "none",
      specSource: "default",
      freeRateLimit: isNvidia
        ? { rpm: 5, tpm: 200_000 }
        : isGemini
          ? { rpm: 15, tpm: 1_000_000 }
          : undefined,
    },
    model,
    providerId
  );
}

// ---- Dynamic Variant Generation ---------------------------------------------

/**
 * Default variant percentages relative to maxOutputTokens.
 * Exported so consumers can reference or override these thresholds.
 */
export const VARIANT_PERCENTAGES = {
  low: 0.10,
  medium: 0.25,
  high: 0.50,
  max: 0.75,
} as const;

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}K`;
  return String(n);
}

function generateBudgetVariants(spec: ModelSpec): ThinkingVariant[] {
  const max = spec.maxOutputTokens;
  const p = VARIANT_PERCENTAGES;
  return [
    { name: "off",    value: 0,                      desc: `Tắt suy nghĩ (0 tokens)` },
    { name: "low",    value: Math.round(max * p.low),    desc: `Suy nghĩ nhẹ (~${fmtTokens(Math.round(max * p.low))} tokens)` },
    { name: "medium", value: Math.round(max * p.medium), desc: `Suy nghĩ vừa (~${fmtTokens(Math.round(max * p.medium))} tokens)` },
    { name: "high",   value: Math.round(max * p.high),   desc: `Suy nghĩ sâu (~${fmtTokens(Math.round(max * p.high))} tokens)` },
    { name: "max",    value: Math.round(max * p.max),    desc: `Suy nghĩ tối đa (~${fmtTokens(Math.round(max * p.max))} tokens)` },
  ];
}

function generateEffortVariants(spec: ModelSpec): ThinkingVariant[] {
  return (spec.effortLevels ?? ["low", "medium", "high"]).map((level) => ({
    name: level,
    value: level,
    desc: `${level.charAt(0).toUpperCase() + level.slice(1)} reasoning effort`,
  }));
}

// ---- Public API -------------------------------------------------------------

/**
 * Get the thinking configuration and available variants for a model.
 *
 * This replaces the old hardcoded approach — variants are now computed
 * dynamically from each model's real maxOutputTokens.
 */
export function getModelThinkingConfig(_provider: string, model: string): ModelThinkingConfig {
  const spec = getModelSpec(model);

  if (spec.thinkingType === "none") {
    return {
      supported: false,
      default: "off",
      variants: [],
      maxOutputTokens: spec.maxOutputTokens,
    };
  }

  if (spec.thinkingType === "effort") {
    const variants = generateEffortVariants(spec);
    return {
      supported: true,
      default: "medium",
      variants,
      maxOutputTokens: spec.maxOutputTokens,
    };
  }

  // budget-based
  const variants = generateBudgetVariants(spec);
  return {
    supported: true,
    default: Math.round(spec.maxOutputTokens * 0.25),
    variants,
    maxOutputTokens: spec.maxOutputTokens,
  };
}

/** Expose registry for context-tracker sync. */
export function getRegisteredContextWindow(model: string): number | null {
  const spec = getModelSpec(model);
  return spec.contextWindow;
}
