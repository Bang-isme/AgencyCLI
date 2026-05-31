import { describe, it, expect, vi } from "vitest";
import { compactTurnHistory } from "../chat/turn-helpers.js";
import type { ChatMessage } from "../chat/orchestrator.js";

// A 7-message turn: system + 2 middle + 4 recent. Mirrors how runChatTurn builds
// turnHistory = [system, ...history, userPrompt].
const turn = (): ChatMessage[] =>
  [
    { role: "system", content: "original instruction" },
    { role: "user", content: "middle turn one with some content" },
    { role: "assistant", content: "middle turn two with some content" },
    { role: "user", content: "recent turn 4" },
    { role: "assistant", content: "recent turn 3" },
    { role: "user", content: "recent turn 2" },
    { role: "assistant", content: "recent turn 1" },
  ] as ChatMessage[];

describe("compactTurnHistory (roadmap §2.3 context-window compaction)", () => {
  it("returns the history unchanged when under the token threshold", async () => {
    const provider = { complete: vi.fn() };
    const res = await compactTurnHistory(turn(), provider, 100_000);

    expect(res.compacted).toBe(false);
    expect(res.summarizedTurns).toBe(0);
    expect(res.messages.length).toBe(7);
    expect(provider.complete).not.toHaveBeenCalled(); // no summarisation cost when not needed
  });

  it("returns unchanged when too short to compress without losing context", async () => {
    const provider = { complete: vi.fn() };
    // 5 messages ≤ keepRecent(4) + 2 → skip even over threshold.
    const short = turn().slice(0, 5);
    const res = await compactTurnHistory(short, provider, 1);

    expect(res.compacted).toBe(false);
    expect(res.messages.length).toBe(5);
    expect(provider.complete).not.toHaveBeenCalled();
  });

  it("summarizes the middle via the provider's real positional API when over threshold", async () => {
    const provider = { complete: vi.fn().mockResolvedValue("Concise summary") };
    const res = await compactTurnHistory(turn(), provider, 20);

    expect(res.compacted).toBe(true);
    expect(res.summarizedTurns).toBe(2);
    expect(res.messages.length).toBe(6); // system + summary + last 4
    expect(res.messages[0].content).toBe("original instruction"); // system kept
    expect(res.messages[1].role).toBe("system");
    expect(res.messages[1].content).toContain("Concise summary");
    expect(res.messages[2].content).toBe("recent turn 4"); // recent kept verbatim
    expect(res.messages[5].content).toBe("recent turn 1");

    // Called as complete(messages[], { maxTokens }) — NOT complete({ messages }).
    const [firstArg, secondArg] = provider.complete.mock.calls[0];
    expect(Array.isArray(firstArg)).toBe(true);
    expect(firstArg[0].role).toBe("user");
    expect(secondArg).toMatchObject({ maxTokens: expect.any(Number) });
  });

  it("falls back to a placeholder summary when the provider throws (never breaks a turn)", async () => {
    const provider = { complete: vi.fn().mockRejectedValue(new Error("LLM down")) };
    const res = await compactTurnHistory(turn(), provider, 20);

    expect(res.compacted).toBe(true);
    expect(res.messages.length).toBe(6);
    expect(res.messages[1].content).toContain("earlier turn(s) omitted");
  });

  it("falls back without throwing when no provider is supplied", async () => {
    const res = await compactTurnHistory(turn(), null, 20);

    expect(res.compacted).toBe(true);
    expect(res.messages[1].content).toContain("earlier turn(s) omitted");
  });
});
