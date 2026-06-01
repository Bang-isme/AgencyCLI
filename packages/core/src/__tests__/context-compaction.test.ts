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

  it("chunks a large middle so the summarizer prompt never overflows (bounded input)", async () => {
    // Three large middle turns + four recent; force chunking with a tiny budget.
    const messages: ChatMessage[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "M1 " + "a".repeat(200) },
      { role: "assistant", content: "M2 " + "b".repeat(200) },
      { role: "user", content: "M3 " + "c".repeat(200) },
      { role: "user", content: "recent 4" },
      { role: "assistant", content: "recent 3" },
      { role: "user", content: "recent 2" },
      { role: "assistant", content: "recent 1" },
    ] as ChatMessage[];

    const provider = { complete: vi.fn().mockResolvedValue("partial") };
    const res = await compactTurnHistory(messages, provider, 20, { maxInputChars: 250 });

    expect(res.compacted).toBe(true);
    expect(res.summarizedTurns).toBe(3); // the three middle turns
    expect(res.messages.length).toBe(6); // system + summary + last 4
    expect(res.messages[1].content).toContain("partial");

    // It did NOT single-shot a giant prompt: multiple bounded calls were made…
    expect(provider.complete.mock.calls.length).toBeGreaterThan(1);
    // …and every call's input stayed within the budget (+ the fixed instruction).
    for (const [msgs] of provider.complete.mock.calls) {
      expect((msgs[0].content as string).length).toBeLessThan(250 + 300);
    }
  });

  it("running summary (cacheKey): a later, grown middle only summarizes the new turns", async () => {
    const big = (tag: string) => `${tag} ${tag.toLowerCase().repeat(40)}`;
    const provider = { complete: vi.fn().mockResolvedValue("PRIORSUM") };
    const cacheKey = "sess-running-test-unique";

    // Turn A: middle = [ALPHA, BETA] (the other 4 are recent).
    const turnA: ChatMessage[] = [
      { role: "system", content: "sys" },
      { role: "user", content: big("ALPHA") },
      { role: "assistant", content: big("BETA") },
      { role: "user", content: "r4" },
      { role: "assistant", content: "r3" },
      { role: "user", content: "r2" },
      { role: "assistant", content: "r1" },
    ] as ChatMessage[];
    const resA = await compactTurnHistory(turnA, provider, 20, { cacheKey });
    expect(resA.compacted).toBe(true);

    // Turn B: one more turn appended → the old "r4" slides into the middle, so
    // the middle GREW from [ALPHA,BETA] to [ALPHA,BETA,GAMMA].
    const turnB: ChatMessage[] = [
      { role: "system", content: "sys" },
      { role: "user", content: big("ALPHA") },
      { role: "assistant", content: big("BETA") },
      { role: "user", content: big("GAMMA") },
      { role: "assistant", content: "r3" },
      { role: "user", content: "r2" },
      { role: "assistant", content: "r1" },
      { role: "user", content: "newest" },
    ] as ChatMessage[];
    const resB = await compactTurnHistory(turnB, provider, 20, { cacheKey });
    expect(resB.compacted).toBe(true);

    // The most recent summarizer call folded the prior summary + only the NEW
    // turn — it did NOT re-send the already-summarized ALPHA/BETA verbatim.
    const lastInput = (provider.complete.mock.calls.at(-1)![0][0].content as string);
    expect(lastInput).toContain("Summary of the earlier conversation so far: PRIORSUM");
    expect(lastInput).toContain("GAMMA");
    expect(lastInput).not.toContain("ALPHA");
  });
});
