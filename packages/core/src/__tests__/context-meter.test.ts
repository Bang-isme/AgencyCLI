import { describe, expect, it } from "vitest";
import {
  decomposeSystemPrompt,
  estimateContextBreakdown,
  estimateTextTokens,
  mergeInflightContext,
} from "../chat/context-meter.js";
import { buildSystemPrompt } from "../chat/prompt.js";
import type { RouteResult } from "../router/model-router.js";

const route: RouteResult = {
  intent: "code",
  suggested_agent: "frontend-specialist",
  workflow: "fix",
  skills: ["codex-test-driven-development"],
  provider: "nvidia",
  warnings: [],
};

describe("context-meter", () => {
  it("decomposes system prompt into named segments", () => {
    const full = buildSystemPrompt(route, "fix footer", "# Context\nfile tree", "/proj");
    const parts = decomposeSystemPrompt(full);
    expect(parts.systemPrompt.length).toBeGreaterThan(50);
    expect(parts.toolDefinitions).toContain("AVAILABLE TOOLS");
    expect(parts.subagentDefinitions).toContain("AVAILABLE SPECIALISTS");
    expect(parts.rules).toContain("WORKING PROGRESSION");
    expect(parts.skills).toContain("# Context");
  });

  it("turn payload total exceeds session-only transcript", () => {
    const session = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
    ];
    const breakdown = estimateContextBreakdown({
      model: "minimax-m3",
      providerId: "nvidia",
      sessionMessages: session,
      userPrompt: "hello",
      contextPack: "# Context\n",
      projectRoot: "/proj",
      route,
    });
    expect(breakdown.totalTokens).toBeGreaterThan(breakdown.sessionOnlyTokens);
    expect(breakdown.segments.some((s) => s.id === "toolDefinitions")).toBe(true);
    expect(breakdown.segments.some((s) => s.id === "conversation")).toBe(true);
    expect(breakdown.contextWindow).toBeGreaterThanOrEqual(1_000_000);
  });

  it("classifies compaction summary in turn history", () => {
    const breakdown = estimateContextBreakdown({
      model: "gpt-4o-mini",
      turnMessages: [
        { role: "system", content: buildSystemPrompt(route, "q", "", "/p") },
        { role: "system", content: "[CONVERSATION SUMMARY]: earlier turns omitted" },
        { role: "user", content: "recent question" },
      ],
    });
    const summarized = breakdown.segments.find((s) => s.id === "summarizedConversation");
    expect(summarized?.tokens).toBeGreaterThan(0);
  });

  it("estimateTextTokens uses conservative 3.5 chars/token", () => {
    expect(estimateTextTokens("a".repeat(3500))).toBe(1000);
  });

  it("mergeInflightContext adds streaming assistant text to turn payload", () => {
    const base = estimateContextBreakdown({
      model: "gpt-4o-mini",
      turnMessages: [
        { role: "system", content: "system" },
        { role: "user", content: "hello" },
      ],
    });
    const withInflight = mergeInflightContext(
      base,
      "<tool_call name=\"dispatch_parallel\">\n<tasks>[{\"agentId\":\"a\",\"task\":\"x\"}]</tasks>\n</tool_call>"
    );
    expect(withInflight.totalTokens).toBeGreaterThan(base.totalTokens);
    expect(withInflight.includesInflight).toBe(true);
    expect(withInflight.segments.some((s) => s.id === "inflightResponse")).toBe(true);
  });
});
