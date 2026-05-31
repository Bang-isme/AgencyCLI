import { describe, expect, it } from "vitest";
import { getModelThinkingConfig, getModelSpec, resolveModelSpec, MODEL_REGISTRY } from "../thinking-spec.js";

describe("resolveModelSpec", () => {
  it("resolves exact model names", () => {
    const spec = resolveModelSpec("gemini-2.0-flash");
    expect(spec).not.toBeNull();
    expect(spec!.maxOutputTokens).toBe(8192);
  });

  it("resolves slash-prefixed names", () => {
    const spec = resolveModelSpec("deepseek/deepseek-r1");
    expect(spec).not.toBeNull();
    expect(spec!.maxOutputTokens).toBe(64000);
  });

  it("resolves date-suffixed names", () => {
    const spec = resolveModelSpec("claude-sonnet-4-20250514");
    expect(spec).not.toBeNull();
    expect(spec!.maxOutputTokens).toBe(128000);
  });

  it("returns null for unknown models", () => {
    expect(resolveModelSpec("totally-unknown-model-xyz")).toBeNull();
  });
});

describe("getModelSpec", () => {
  it("returns spec for known models", () => {
    const spec = getModelSpec("deepseek-v4-pro");
    expect(spec.maxOutputTokens).toBe(384000);
    expect(spec.thinkingType).toBe("none");
  });

  it("returns sensible defaults for unknown models", () => {
    const spec = getModelSpec("unknown-model");
    expect(spec.maxOutputTokens).toBe(4096);
    expect(spec.thinkingType).toBe("none");
  });

  it("resolves unknown model parameters using heuristics fallback", () => {
    const specLlama = getModelSpec("nvidia/llama-3.3-70b-instruct");
    expect(specLlama.contextWindow).toBe(131_072);
    expect(specLlama.maxOutputTokens).toBe(16384);
    expect(specLlama.thinkingType).toBe("none");

    const specDeepSeek = getModelSpec("nvidia/deepseek-r1-nim");
    expect(specDeepSeek.contextWindow).toBe(128_000);
    expect(specDeepSeek.maxOutputTokens).toBe(64000);
    expect(specDeepSeek.thinkingType).toBe("budget");
  });

  it("resolves dynamic parameters for new models (kimi, minimax, qwen, yi) without hardcoding", () => {
    // Kimi with explicit 128k -> maps to exact 128K binary limit (131,072)
    const specKimi = getModelSpec("moonshot/kimi-custom-128k");
    expect(specKimi.contextWindow).toBe(131_072);
    expect(specKimi.maxOutputTokens).toBe(4096);
    expect(specKimi.thinkingType).toBe("none");
    expect(specKimi.specSource).toBe("heuristics");

    // Minimax with explicit 256k -> maps to exact 256K binary limit (262,144)
    const specMinimax = getModelSpec("minimax/minimax-custom-256k");
    expect(specMinimax.contextWindow).toBe(262_144);
    expect(specMinimax.maxOutputTokens).toBe(4096);
    expect(specMinimax.thinkingType).toBe("none");

    // Kimi K2.6 family fallback without explicit suffix -> maps to exact 256K binary limit (262,144)
    const specKimiK26 = getModelSpec("moonshot/kimi-k2.6");
    expect(specKimiK26.contextWindow).toBe(262_144);

    // Minimax 2.7 family fallback without explicit suffix -> maps to exact 200K (204,800)
    const specMinimax27 = getModelSpec("minimax/minimax-2.7");
    expect(specMinimax27.contextWindow).toBe(204_800);

    // Kimi R1 / K1 with reasoning and 128k
    const specKimiR1 = getModelSpec("moonshot/kimi-k1.5-r1-128k");
    expect(specKimiR1.contextWindow).toBe(131_072);
    expect(specKimiR1.maxOutputTokens).toBe(64000);
    expect(specKimiR1.thinkingType).toBe("budget");

    // Minimax with reasoning/thinking and 1m context
    const specMinimaxThinking = getModelSpec("minimax/minimax-custom-thinking-1m");
    expect(specMinimaxThinking.contextWindow).toBe(1_000_000);
    expect(specMinimaxThinking.maxOutputTokens).toBe(8192);
    expect(specMinimaxThinking.thinkingType).toBe("budget");

    // Qwen 2.5 with 128k
    const specQwen = getModelSpec("qwen/qwen-2.5-72b-instruct-128k");
    expect(specQwen.contextWindow).toBe(131_072);

    // Yi 34b chat 32k
    const specYi = getModelSpec("yi/yi-34b-chat-32k");
    expect(specYi.contextWindow).toBe(32_768);

    // Standard raw numbers in name
    const specRaw32k = getModelSpec("provider/custom-model-32768");
    expect(specRaw32k.contextWindow).toBe(32_768);
  });
});

describe("getModelThinkingConfig", () => {
  it("Gemini 2.5 Pro has different variants than Gemini 2.0 Flash", () => {
    const pro = getModelThinkingConfig("google", "gemini-2.5-pro");
    const flash = getModelThinkingConfig("google", "gemini-2.0-flash");

    expect(pro.supported).toBe(true);
    expect(flash.supported).toBe(true);

    // Pro has maxOutputTokens=65536, Flash has 8192
    // So their variant values must be different
    expect(pro.maxOutputTokens).toBe(65536);
    expect(flash.maxOutputTokens).toBe(8192);

    // "low" variant value should differ
    const proLow = pro.variants.find((v) => v.name === "low");
    const flashLow = flash.variants.find((v) => v.name === "low");
    expect(proLow!.value).not.toBe(flashLow!.value);
    expect(proLow!.value).toBe(Math.round(65536 * 0.10));
    expect(flashLow!.value).toBe(Math.round(8192 * 0.10));
  });

  it("Gemini 2.0 Flash: budget-based with 5 levels", () => {
    const config = getModelThinkingConfig("google", "gemini-2.0-flash");
    expect(config.supported).toBe(true);
    expect(config.maxOutputTokens).toBe(8192);
    expect(config.variants).toHaveLength(5);
    expect(config.variants[0]!.name).toBe("off");
    expect(config.variants[0]!.value).toBe(0);
  });

  it("Gemini 2.5 Pro: much higher variant values than Flash", () => {
    const pro = getModelThinkingConfig("google", "gemini-2.5-pro");
    const flash = getModelThinkingConfig("google", "gemini-2.0-flash");

    expect(pro.maxOutputTokens).toBe(65536);
    expect(flash.maxOutputTokens).toBe(8192);

    const proHigh = pro.variants.find((v) => v.name === "high")!;
    const flashHigh = flash.variants.find((v) => v.name === "high")!;
    expect(proHigh.value).toBeGreaterThan(flashHigh.value as number);
  });

  it("OpenAI o-series: effort-based with string values", () => {
    const config = getModelThinkingConfig("openai", "o3-mini");
    expect(config.supported).toBe(true);
    expect(config.variants).toHaveLength(3);
    expect(config.variants[0]!.name).toBe("low");
    expect(config.variants[0]!.value).toBe("low");
    expect(config.variants[2]!.name).toBe("high");
    expect(config.variants[2]!.value).toBe("high");
  });

  it("Claude Sonnet 4: budget-based with proper maxOutput", () => {
    const config = getModelThinkingConfig("anthropic", "claude-sonnet-4-20250514");
    expect(config.supported).toBe(true);
    expect(config.maxOutputTokens).toBe(128000);
    expect(config.variants).toHaveLength(5);
  });

  it("GPT-4o: unsupported thinking", () => {
    const config = getModelThinkingConfig("openai", "gpt-4o");
    expect(config.supported).toBe(false);
    expect(config.variants).toHaveLength(0);
  });

  it("Claude 3.5 Sonnet: unsupported thinking", () => {
    const config = getModelThinkingConfig("anthropic", "claude-3-5-sonnet-20241022");
    expect(config.supported).toBe(false);
    expect(config.variants).toHaveLength(0);
  });

  describe("exhaustive MODEL_REGISTRY validation", () => {
    it.each(Object.entries(MODEL_REGISTRY))("verifies %s has valid context, output tokens, and thinking type", (modelId, spec) => {
      expect(spec.contextWindow).toBeGreaterThan(0);
      expect(spec.maxOutputTokens).toBeGreaterThan(0);
      expect(["budget", "effort", "none"]).toContain(spec.thinkingType);
    });
  });
});
