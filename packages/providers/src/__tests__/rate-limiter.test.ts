import { describe, expect, it, vi } from "vitest";
import { SmartRateLimiter } from "../rate-limiter.js";

describe("SmartRateLimiter", () => {
  it("tracks RPM utilization correctly", async () => {
    const limiter = new SmartRateLimiter({ rpm: 5, tpm: 0 });
    expect(limiter.getAdaptedRpm()).toBe(5);

    // Initial utilization
    let util = limiter.getUtilization();
    expect(util.rpmPercent).toBe(0);
    expect(util.tpmPercent).toBeNull();
    expect(util.throttled).toBe(false);

    // Record one request
    limiter.recordUsage(100);
    util = limiter.getUtilization();
    expect(util.rpmPercent).toBe(20); // 1/5 = 20%
    expect(limiter.isThrottled()).toBe(false);
  });

  it("handles TPM checks", async () => {
    const limiter = new SmartRateLimiter({ rpm: 10, tpm: 1000 });
    limiter.recordUsage(600);

    const util = limiter.getUtilization();
    expect(util.tpmPercent).toBe(60); // 600/1000 = 60%
  });

  it("adapts RPM limit on 429 rate limit error", () => {
    const limiter = new SmartRateLimiter({ rpm: 10 });
    expect(limiter.getAdaptedRpm()).toBe(10);

    limiter.recordRateLimit();
    expect(limiter.getAdaptedRpm()).toBe(8); // 10 * 0.8 = 8

    limiter.recordRateLimit();
    expect(limiter.getAdaptedRpm()).toBe(6); // 8 * 0.8 = 6.4 -> 6

    limiter.resetAdaptation();
    expect(limiter.getAdaptedRpm()).toBe(10);
  });

  it("retries with backoff and succeeds on eventual success", async () => {
    const limiter = new SmartRateLimiter({
      rpm: 10,
      retryMaxAttempts: 2,
      retryBaseDelayMs: 1, // fast for tests
    });

    let calls = 0;
    const result = await limiter.retryWithBackoff(async () => {
      calls++;
      if (calls === 1) {
        throw new Error("429 rate limit exceeded");
      }
      return "success-data";
    });

    expect(result).toBe("success-data");
    expect(calls).toBe(2);
    expect(limiter.getAdaptedRpm()).toBe(8); // adapted down due to 429
  });

  it("throws after exceeding max retry attempts on 429", async () => {
    const limiter = new SmartRateLimiter({
      rpm: 10,
      retryMaxAttempts: 1,
      retryBaseDelayMs: 1,
    });

    let calls = 0;
    await expect(
      limiter.retryWithBackoff(async () => {
        calls++;
        throw new Error("429 Too Many Requests");
      })
    ).rejects.toThrow("429 Too Many Requests");

    expect(calls).toBe(2); // attempt 0 and attempt 1
  });

  it("recognizes smart rate-limiting and temporary server error signatures", async () => {
    const limiter = new SmartRateLimiter({
      rpm: 10,
      retryMaxAttempts: 1,
      retryBaseDelayMs: 1,
    });

    // Test 1: error with status property
    let calls = 0;
    const result1 = await limiter.retryWithBackoff(async () => {
      calls++;
      if (calls === 1) {
        const err = new Error("General error") as any;
        err.status = 503;
        throw err;
      }
      return "done-1";
    });
    expect(result1).toBe("done-1");
    expect(calls).toBe(2);

    // Test 2: error with "RESOURCE_EXHAUSTED" or "quota" text
    calls = 0;
    const result2 = await limiter.retryWithBackoff(async () => {
      calls++;
      if (calls === 1) {
        throw new Error("Resource has been exhausted (Google AI Studio free tier)");
      }
      return "done-2";
    });
    expect(result2).toBe("done-2");
    expect(calls).toBe(2);

    // Test 3: error with "gateway timeout" text
    calls = 0;
    const result3 = await limiter.retryWithBackoff(async () => {
      calls++;
      if (calls === 1) {
        throw new Error("504 Gateway Timeout from Nvidia NIM proxy");
      }
      return "done-3";
    });
    expect(result3).toBe("done-3");
    expect(calls).toBe(2);
  });
});
