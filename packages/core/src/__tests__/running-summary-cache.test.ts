import { describe, expect, it, vi } from "vitest";
import { compactTurnHistory, clearRunningSummaryCache } from "../chat/turn-helpers.js";
import type { ChatMessage } from "../chat/orchestrator.js";

describe("runningSummaryCache memory cleanup", () => {
  it("compactTurnHistory uses runningSummaryCache when cacheKey is provided, and clearRunningSummaryCache properly clears it", async () => {
    const provider = {
      complete: vi.fn(async () => "Mocked Summary of earlier conversation"),
    };

    const messages: ChatMessage[] = [
      { role: "system", content: "You are helpful." },
      { role: "user", content: "Turn 1: " + "a".repeat(100) },
      { role: "assistant", content: "Reply 1: " + "b".repeat(100) },
      { role: "user", content: "Turn 2: " + "c".repeat(100) },
      { role: "assistant", content: "Reply 2: " + "d".repeat(100) },
      { role: "user", content: "Turn 3: " + "e".repeat(100) },
      { role: "assistant", content: "Reply 3: " + "f".repeat(100) },
      { role: "user", content: "Turn 4: " + "g".repeat(100) },
    ];

    // 1. First compaction with cacheKey: should trigger provider.complete
    const cacheKey = "test-session-id-123";
    const res1 = await compactTurnHistory(messages, provider, 1000, {
      cacheKey,
      thresholdRatio: 0.01, // trigger compaction easily
      keepRecent: 2,
    });

    expect(res1.compacted).toBe(true);
    expect(provider.complete).toHaveBeenCalledTimes(1);

    // 2. Second compaction with same cacheKey and identical messages: should NOT trigger provider.complete (cache hit)
    const res2 = await compactTurnHistory(messages, provider, 1000, {
      cacheKey,
      thresholdRatio: 0.01,
      keepRecent: 2,
    });

    expect(res2.compacted).toBe(true);
    expect(provider.complete).toHaveBeenCalledTimes(1); // Still 1

    // 3. Clear runningSummaryCache for this sessionId
    clearRunningSummaryCache(cacheKey);

    // 4. Third compaction: since cache was cleared, it must trigger provider.complete again (cache miss)
    const res3 = await compactTurnHistory(messages, provider, 1000, {
      cacheKey,
      thresholdRatio: 0.01,
      keepRecent: 2,
    });

    expect(res3.compacted).toBe(true);
    expect(provider.complete).toHaveBeenCalledTimes(2); // Incremented to 2!
  });
});
