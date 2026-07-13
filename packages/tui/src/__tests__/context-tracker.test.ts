import { describe, expect, it } from "vitest";
import { estimateContextUsage } from "../state/context-tracker.js";

describe("context-tracker", () => {
  it("reports full turn estimate higher than session transcript only", () => {
    const messages = [{ role: "user", content: "a".repeat(3500) }];
    const usage = estimateContextUsage(messages, "nvidia/minimax-m3", {
      userPrompt: "a".repeat(3500),
      contextPack: "# Context\n",
      projectRoot: process.cwd(),
      providerId: "nvidia",
    });
    expect(usage.estimatedTokens).toBeGreaterThan(usage.sessionOnlyTokens);
    expect(usage.breakdown.segments.length).toBeGreaterThan(2);
    expect(usage.percent).toBeLessThan(100);
  });

  it("includes in-flight streaming text in the estimate while loading", () => {
    const messages = [{ role: "user", content: "hello" }];
    const base = estimateContextUsage(messages, "nvidia/minimax-m3", {
      userPrompt: "hello",
      contextPack: "",
      projectRoot: process.cwd(),
      providerId: "nvidia",
    });
    const streaming = estimateContextUsage(messages, "nvidia/minimax-m3", {
      userPrompt: "hello",
      contextPack: "",
      projectRoot: process.cwd(),
      providerId: "nvidia",
      inflightAssistantText: "<tool_call>" + "x".repeat(7000),
    });
    expect(streaming.estimatedTokens).toBeGreaterThan(base.estimatedTokens);
    expect(streaming.breakdown.includesInflight).toBe(true);
  });
});
