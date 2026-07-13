import { describe, expect, it, vi } from "vitest";
import { compactTurnHistory, clearRunningSummaryCache } from "../chat/turn-helpers.js";
import type { ChatMessage } from "../chat/orchestrator.js";

describe("Milestone 10: Memory Compaction & Caching Stress Tests", () => {
  it("compacts large chat history and releases cache memory", async () => {
    // 1. Setup a mock LLM provider that simulates summarizing
    const provider = {
      complete: vi.fn(async (messages: ChatMessage[]) => {
        const lastMsg = messages[messages.length - 1]?.content || "";
        return `[Summary of: ${lastMsg.substring(0, 50)}...]`;
      }),
    };

    // 2. Generate a large chat history (e.g. 200 turns)
    const systemPrompt: ChatMessage = { role: "system", content: "You are an assistant." };
    const history: ChatMessage[] = [systemPrompt];
    for (let i = 1; i <= 100; i++) {
      history.push({ role: "user", content: `User turn ${i} with long text ${"a".repeat(100)}` });
      history.push({ role: "assistant", content: `Assistant turn ${i} with response ${"b".repeat(100)}` });
    }

    // Add a final user message
    history.push({ role: "user", content: "Final query from user" });

    // 3. Compact with cache key
    const session1 = "session-stress-1";
    const limit = 2000; // Force compaction by setting limit low relative to estimated token size

    const res1 = await compactTurnHistory(history, provider, limit, {
      cacheKey: session1,
      thresholdRatio: 0.1, // Easy trigger
      keepRecent: 4,
    });

    expect(res1.compacted).toBe(true);
    expect(res1.summarizedTurns).toBeGreaterThan(0);
    expect(provider.complete).toHaveBeenCalled();

    // Verify history structure: system prompt + summary + recent turns
    expect(res1.messages[0]?.role).toBe("system");
    expect(res1.messages[1]?.role).toBe("system");
    expect(res1.messages[1]?.content).toContain("[CONVERSATION SUMMARY]");
    expect(res1.messages.length).toBe(6); // 1 (system) + 1 (summary) + 4 (recent)

    const callCountAfterFirst = provider.complete.mock.calls.length;

    // 4. Compact again with same messages: should hit cache and NOT call provider.complete
    const res2 = await compactTurnHistory(history, provider, limit, {
      cacheKey: session1,
      thresholdRatio: 0.1,
      keepRecent: 4,
    });

    expect(res2.compacted).toBe(true);
    expect(provider.complete).toHaveBeenCalledTimes(callCountAfterFirst);

    // 5. Append new turns and compact incrementally
    const appendedHistory = [...history];
    appendedHistory.push({ role: "assistant", content: "Intermediate response" });
    appendedHistory.push({ role: "user", content: "New question" });

    const res3 = await compactTurnHistory(appendedHistory, provider, limit, {
      cacheKey: session1,
      thresholdRatio: 0.1,
      keepRecent: 4,
    });

    expect(res3.compacted).toBe(true);
    // Since we appended messages, it should do incremental summarization (calling complete again)
    expect(provider.complete.mock.calls.length).toBeGreaterThan(callCountAfterFirst);

    // Verify cache clearing and memory release
    clearRunningSummaryCache(session1);

    // After clearing, compaction with the same key should trigger a fresh call to the provider (cache miss)
    const callCountBeforeMiss = provider.complete.mock.calls.length;
    await compactTurnHistory(appendedHistory, provider, limit, {
      cacheKey: session1,
      thresholdRatio: 0.1,
      keepRecent: 4,
    });
    expect(provider.complete.mock.calls.length).toBeGreaterThan(callCountBeforeMiss);
  });

  it("handles chunked summarization under extremely large input sizes without throwing", async () => {
    const provider = {
      complete: vi.fn(async () => "Chunk summary"),
    };

    // Create a history where the middle part exceeds the maxInputChars option
    const systemPrompt: ChatMessage = { role: "system", content: "System" };
    const middlePart: ChatMessage[] = Array.from({ length: 50 }, (_, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
      content: `Message ${i}: ` + "x".repeat(300), // Total size is ~15000 chars, well above maxInputChars limit of 2000
    }));
    const recentPart: ChatMessage[] = [
      { role: "user", content: "Recent 1" },
      { role: "assistant", content: "Recent 2" },
    ];

    const history = [systemPrompt, ...middlePart, ...recentPart];

    // Compact with a low maxInputChars to force chunking
    const res = await compactTurnHistory(history, provider, 1000, {
      thresholdRatio: 0.1,
      keepRecent: 2,
      maxInputChars: 2000,
    });

    expect(res.compacted).toBe(true);
    // Should have chunked and combined, calling complete multiple times
    expect(provider.complete.mock.calls.length).toBeGreaterThan(1);
    expect(res.messages[1]?.content).toContain("[CONVERSATION SUMMARY]");
  });
});
