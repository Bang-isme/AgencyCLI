import { describe, expect, it } from "vitest";
import { inferTaskIntent, optimizeForTask, detectFlop } from "../token-optimizer.js";
import type { ModelSpec } from "../thinking-spec.js";

describe("TokenOptimizer - inferTaskIntent", () => {
  it("infers search intent", () => {
    expect(inferTaskIntent("Please search for the latest tech news")).toBe("search");
    expect(inferTaskIntent("tìm kiếm thông tin")).toBe("search");
  });

  it("infers tool call intent", () => {
    expect(inferTaskIntent("run a script to build this")).toBe("tool_call");
    expect(inferTaskIntent("execute the query")).toBe("tool_call");
  });

  it("infers reasoning intent", () => {
    expect(inferTaskIntent("explain the difference between REST and GraphQL")).toBe("reasoning");
    expect(inferTaskIntent("debug the following memory leak")).toBe("reasoning");
  });

  it("infers generation intent", () => {
    expect(inferTaskIntent("write a poetry about love")).toBe("generation");
    expect(inferTaskIntent("create a React component")).toBe("generation");
  });

  it("defaults to chat for general inputs", () => {
    expect(inferTaskIntent("Hello there, how are you?")).toBe("chat");
  });

  it("distinguishes run tests from debug tests", () => {
    expect(inferTaskIntent("run vitest tests")).toBe("tool_call");
    expect(inferTaskIntent("lint this file")).toBe("tool_call");
    expect(inferTaskIntent("debug the failing test")).toBe("reasoning");
    expect(inferTaskIntent("fix prettier formatting")).toBe("reasoning");
  });
});

describe("TokenOptimizer - optimizeForTask", () => {
  const spec: ModelSpec = {
    maxOutputTokens: 8192,
    contextWindow: 128_000,
    thinkingType: "budget",
  };

  it("optimizes search intent with minimal budget", () => {
    const opt = optimizeForTask("search", spec);
    expect(opt.maxOutputTokens).toBe(Math.round(8192 * 0.30));
    expect(opt.thinkingBudget).toBe(Math.round(8192 * 0.05));
    expect(opt.temperature).toBe(0.2);
  });

  it("optimizes reasoning intent with max budget", () => {
    const opt = optimizeForTask("reasoning", spec);
    expect(opt.maxOutputTokens).toBe(Math.round(8192 * 0.80));
    expect(opt.thinkingBudget).toBe(Math.round(8192 * 0.50));
    expect(opt.temperature).toBeNull();
  });

  it("honors currentThinking user variant budget as a ceiling", () => {
    // If user set /variant low (value = 819)
    const opt = optimizeForTask("reasoning", spec, 819);
    // Ideal reasoning thinking budget is 4096, but ceiling is 819
    expect(opt.thinkingBudget).toBe(819);
  });

  it("bypasses optimization if DISABLE_TOKEN_OPTIMIZER is set", () => {
    process.env.DISABLE_TOKEN_OPTIMIZER = "true";
    try {
      const opt = optimizeForTask("search", spec);
      expect(opt.maxOutputTokens).toBe(8192);
      expect(opt.thinkingBudget).toBeNull();
      expect(opt.reason).toContain("bypassed");
    } finally {
      delete process.env.DISABLE_TOKEN_OPTIMIZER;
    }
  });
});

describe("TokenOptimizer - detectFlop", () => {
  const spec: ModelSpec = {
    maxOutputTokens: 8192,
    contextWindow: 128_000,
    thinkingType: "budget",
  };

  it("identifies major flop on empty response", () => {
    const flop = detectFlop(
      {
        outputTokens: 0,
        inputTokens: 200,
        wasEmpty: true,
        wasError: false,
        responseTimeMs: 200,
      },
      spec
    );
    expect(flop.isFlop).toBe(true);
    expect(flop.severity).toBe("major");
    expect(flop.suggestion).toContain("empty");
  });

  it("identifies minor flop on too short response relative to input", () => {
    const flop = detectFlop(
      {
        outputTokens: 10, // extremely short
        inputTokens: 500,  // long prompt
        wasEmpty: false,
        wasError: false,
        responseTimeMs: 300,
      },
      spec
    );
    expect(flop.isFlop).toBe(true);
    expect(flop.severity).toBe("minor");
    expect(flop.suggestion).toContain("short");
  });

  it("identifies no flop on healthy response", () => {
    const flop = detectFlop(
      {
        outputTokens: 500,
        inputTokens: 100,
        wasEmpty: false,
        wasError: false,
        responseTimeMs: 1500,
      },
      spec
    );
    expect(flop.isFlop).toBe(false);
    expect(flop.severity).toBe("none");
  });
});
