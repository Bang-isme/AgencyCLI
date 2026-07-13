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

    // Test 4: error with "stream stalled" or "timeout" text
    calls = 0;
    const result4 = await limiter.retryWithBackoff(async () => {
      calls++;
      if (calls === 1) {
        throw new Error("nvidia stream stalled (no token for 90000ms) at https://integrate.api.nvidia.com/v1");
      }
      return "done-4";
    });
    expect(result4).toBe("done-4");
    expect(calls).toBe(2);
  });

  it("recovers adapted RPM limit on successful recordUsage and resets after 30s", async () => {
    vi.useFakeTimers();
    try {
      const limiter = new SmartRateLimiter({ rpm: 10 });
      expect(limiter.getAdaptedRpm()).toBe(10);

      // Trigger 429 to lower the limit
      limiter.recordRateLimit();
      expect(limiter.getAdaptedRpm()).toBe(8);

      // Record successful usage: adaptedRpm should increase by 1
      limiter.recordUsage(100);
      expect(limiter.getAdaptedRpm()).toBe(9);

      // Trigger 429 to lower the limit again
      limiter.recordRateLimit();
      expect(limiter.getAdaptedRpm()).toBe(7);

      // Move forward by 10s: should NOT reset yet
      vi.advanceTimersByTime(10_000);
      await limiter.waitForSlot(0);
      expect(limiter.getAdaptedRpm()).toBe(7);

      // Move forward by another 25s (total 35s since last 429): should reset to config.rpm
      vi.advanceTimersByTime(25_000);
      await limiter.waitForSlot(0);
      expect(limiter.getAdaptedRpm()).toBe(10);
    } finally {
      vi.useRealTimers();
    }
  });

  describe("R4 Upgrades: updateLimitsFromHeaders", () => {
    it("parses Anthropic rate limit headers and updates limits", () => {
      const limiter = new SmartRateLimiter({ rpm: 10, tpm: 1000 });
      const headers = new Map<string, string>([
        ["anthropic-ratelimit-requests-limit", "150"],
        ["anthropic-ratelimit-tokens-limit", "5000"],
      ]);
      limiter.updateLimitsFromHeaders(headers);
      
      expect(limiter.getAdaptedRpm()).toBe(150);
      limiter.recordUsage(500); // 500 / 5000 = 10%
      expect(limiter.getUtilization().tpmPercent).toBe(10);
    });

    it("parses OpenAI/standard rate limit headers and updates limits", () => {
      const limiter = new SmartRateLimiter({ rpm: 10, tpm: 1000 });
      const headers = {
        "X-RateLimit-Limit-Requests": "80",
        "x-ratelimit-limit-tokens": "2000",
      };
      limiter.updateLimitsFromHeaders(headers);
      
      expect(limiter.getAdaptedRpm()).toBe(80);
      limiter.recordUsage(200); // 200 / 2000 = 10%
      expect(limiter.getUtilization().tpmPercent).toBe(10);
    });

    it("limits adaptedRpm when limits are adjusted downwards", () => {
      const limiter = new SmartRateLimiter({ rpm: 50 });
      expect(limiter.getAdaptedRpm()).toBe(50);
      
      const headers = {
        "x-ratelimit-limit-requests": "30",
      };
      limiter.updateLimitsFromHeaders(headers);
      expect(limiter.getAdaptedRpm()).toBe(30);
    });
  });

  describe("R4 Upgrades: retry-after header parsing and blocking", () => {
    it("respects numeric retry-after in seconds", async () => {
      vi.useFakeTimers();
      try {
        const limiter = new SmartRateLimiter({
          rpm: 10,
          retryMaxAttempts: 1,
          retryBaseDelayMs: 1,
        });

        let calls = 0;

        const promise = limiter.retryWithBackoff(async () => {
          calls++;
          if (calls === 1) {
            const err = new Error("429 Rate Limit") as any;
            err.status = 429;
            err.headers = {
              "retry-after": "5", // 5 seconds
            };
            throw err;
          }
          return "success";
        });

        await vi.advanceTimersByTimeAsync(5000);

        const result = await promise;
        expect(result).toBe("success");
        expect(calls).toBe(2);
      } finally {
        vi.useRealTimers();
      }
    });

    it("respects HTTP date format in retry-after", async () => {
      vi.useFakeTimers();
      try {
        const limiter = new SmartRateLimiter({
          rpm: 10,
          retryMaxAttempts: 1,
          retryBaseDelayMs: 1,
        });

        // Set system time to a clean second boundary
        const now = 1718987700000;
        vi.setSystemTime(new Date(now));
        
        // 2 seconds in the future
        const targetTime = new Date(now + 2000);
        const httpDateStr = targetTime.toUTCString();
        let calls = 0;

        const promise = limiter.retryWithBackoff(async () => {
          calls++;
          if (calls === 1) {
            const err = new Error("429 Rate Limit") as any;
            err.status = 429;
            err.headers = new Map([
              ["retry-after", httpDateStr],
            ]);
            throw err;
          }
          return "success";
        });

        await vi.advanceTimersByTimeAsync(2000);

        const result = await promise;
        expect(result).toBe("success");
        expect(calls).toBe(2);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("R4 Upgrades: Global limiter registry", () => {
    it("registers the limiter in global registry when providerId is passed", () => {
      const limiter = new SmartRateLimiter({
        rpm: 10,
        providerId: "test-provider",
      });

      const registry = (globalThis as any).agencyProviderLimiters;
      expect(registry).toBeDefined();
      expect(registry.get("test-provider")).toBe(limiter);
    });
  });
});
