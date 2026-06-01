import { describe, it, expect } from "vitest";
import { tmpdir } from "node:os";
import { estimateMessagesTokens } from "@agency/providers";
import { reduceHistoryToFit } from "../chat/turn-helpers.js";
import type { ChatMessage } from "../chat/orchestrator.js";
import type { RouteResult } from "../router/model-router.js";

// Minimal ctx — the system-prompt repack is best-effort (try/caught), so a bare
// route/plan is fine; this test exercises the BODY reduction, which is the §8.1
// fix (the old reactive handler only repacked turnHistory[0]).
const ctx = () => ({
  input: { prompt: "final question", projectRoot: tmpdir(), skillsRoot: tmpdir() },
  route: { intent: "code", provider: "nvidia" } as unknown as RouteResult,
  plan: {
    mode: "normal" as const,
    maxContextFiles: 12,
    maxContextChars: 4000,
    maxLlmOutputTokens: 2048,
    allowPreflight: false,
    includeFullRouteJson: false,
    useRouteCache: true,
  },
  provider: null,
});

describe("reduceHistoryToFit (§8.1 — reactive trims the conversation body)", () => {
  it("brings an oversized history under newLimit*safety", async () => {
    const big = "x".repeat(40000);
    const turnHistory: ChatMessage[] = [
      { role: "system", content: "sys" },
      { role: "user", content: `tool result 1 ${big}` },
      { role: "assistant", content: `tool result 2 ${big}` },
      { role: "user", content: `tool result 3 ${big}` },
      { role: "assistant", content: `tool result 4 ${big}` },
      { role: "user", content: `tool result 5 ${big}` },
      { role: "assistant", content: `tool result 6 ${big}` },
      { role: "user", content: "final question" },
    ];

    const before = estimateMessagesTokens(turnHistory);
    const newLimit = 20000;
    const res = await reduceHistoryToFit(turnHistory, newLimit, ctx());

    expect(before).toBeGreaterThan(newLimit); // it really was over budget
    expect(res.fits).toBe(true);
    expect(estimateMessagesTokens(res.messages)).toBeLessThanOrEqual(Math.floor(newLimit * 0.8));
  });

  it("never drops the system turn or the final (current) message", async () => {
    const big = "y".repeat(60000);
    const turnHistory: ChatMessage[] = [
      { role: "system", content: "SYS-MARKER" },
      { role: "user", content: `old ${big}` },
      { role: "assistant", content: `older ${big}` },
      { role: "user", content: `oldest ${big}` },
      { role: "user", content: "FINAL-MARKER" },
    ];

    const res = await reduceHistoryToFit(turnHistory, 12000, ctx());

    expect(res.messages[0]!.role).toBe("system");
    expect(res.messages[res.messages.length - 1]!.content).toBe("FINAL-MARKER");
    expect(estimateMessagesTokens(res.messages)).toBeLessThanOrEqual(Math.floor(12000 * 0.8));
  });

  it("is a no-op-ish pass when already small (does not explode tiny histories)", async () => {
    const turnHistory: ChatMessage[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "hi" },
    ];
    const res = await reduceHistoryToFit(turnHistory, 100000, ctx());
    expect(res.fits).toBe(true);
    expect(res.messages[res.messages.length - 1]!.content).toBe("hi");
  });
});
