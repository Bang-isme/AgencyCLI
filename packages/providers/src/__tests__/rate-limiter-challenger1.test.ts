import { describe, expect, it, vi } from "vitest";
import { SmartRateLimiter } from "../rate-limiter.js";

describe("SmartRateLimiter Challenger 1 Empirical Tests", () => {
  describe("Header Parsing & Limit Updates", () => {
    it("handles various cases of standard and Anthropic header keys", () => {
      const limiter = new SmartRateLimiter({ rpm: 10, tpm: 100 });

      // Test standard headers with various casing
      limiter.updateLimitsFromHeaders({
        "X-RATELIMIT-LIMIT-REQUESTS": "40",
        "X-RateLimit-Limit-Tokens": "400",
      });
      expect(limiter.getAdaptedRpm()).toBe(40);
      limiter.recordUsage(200);
      expect(limiter.getUtilization().tpmPercent).toBe(50); // 200/400 = 50%

      // Test alternate standard headers
      limiter.updateLimitsFromHeaders({
        "x-ratelimit-requests-limit": "50",
        "x-ratelimit-tokens-limit": "500",
      });
      expect(limiter.getAdaptedRpm()).toBe(50);
      limiter.recordUsage(250);
      expect(limiter.getUtilization().tpmPercent).toBe(90); // (200+250)/500 = 90%

      // Test Anthropic headers
      limiter.updateLimitsFromHeaders({
        "anthropic-ratelimit-requests-limit": "60",
        "anthropic-ratelimit-tokens-limit": "600",
      });
      expect(limiter.getAdaptedRpm()).toBe(60);
      limiter.recordUsage(90);
      expect(limiter.getUtilization().tpmPercent).toBe(90); // (200+250+90)/600 = 90%
    });

    it("supports Headers and Map objects", () => {
      const limiter = new SmartRateLimiter({ rpm: 10, tpm: 100 });

      // Using Map
      const mapHeaders = new Map<string, string>([
        ["x-ratelimit-limit-requests", "30"],
        ["x-ratelimit-limit-tokens", "300"],
      ]);
      limiter.updateLimitsFromHeaders(mapHeaders);
      expect(limiter.getAdaptedRpm()).toBe(30);

      // Using Headers-like object with a get method
      const headersGetObj = {
        get(key: string) {
          if (key === "anthropic-ratelimit-requests-limit") return "25";
          if (key === "anthropic-ratelimit-tokens-limit") return "250";
          return null;
        }
      };
      limiter.updateLimitsFromHeaders(headersGetObj);
      expect(limiter.getAdaptedRpm()).toBe(25);
    });

    it("ignores non-numeric, negative, and invalid values gracefully", () => {
      const limiter = new SmartRateLimiter({ rpm: 50, tpm: 5000 });

      // Non-numeric limits should be ignored (no change)
      limiter.updateLimitsFromHeaders({
        "x-ratelimit-limit-requests": "abc",
        "x-ratelimit-limit-tokens": "xyz",
      });
      expect(limiter.getAdaptedRpm()).toBe(50);

      // Negative values should be ignored
      limiter.updateLimitsFromHeaders({
        "x-ratelimit-limit-requests": "-10",
        "x-ratelimit-limit-tokens": "-50",
      });
      expect(limiter.getAdaptedRpm()).toBe(50);

      // Empty string values should be ignored
      limiter.updateLimitsFromHeaders({
        "x-ratelimit-limit-requests": "",
        "x-ratelimit-limit-tokens": "",
      });
      expect(limiter.getAdaptedRpm()).toBe(50);

      // RPM zero is invalid (rpmVal > 0), but TPM zero is valid (tpmVal >= 0)
      limiter.updateLimitsFromHeaders({
        "x-ratelimit-limit-requests": "0",
        "x-ratelimit-limit-tokens": "0",
      });
      expect(limiter.getAdaptedRpm()).toBe(50); // RPM unchanged
      limiter.recordUsage(10);
      expect(limiter.getUtilization().tpmPercent).toBeNull(); // TPM should update to 0 (unlimited -> null)
    });
  });

  describe("Adaptive Rate Limiting", () => {
    it("handles exact sequence of consecutive 429 decreases and floor limit of 2", () => {
      const limiter = new SmartRateLimiter({ rpm: 10 });
      expect(limiter.getAdaptedRpm()).toBe(10);

      // 1st 429: 10 * 0.8 = 8
      limiter.recordRateLimit();
      expect(limiter.getAdaptedRpm()).toBe(8);

      // 2nd 429: 8 * 0.8 = 6.4 -> 6
      limiter.recordRateLimit();
      expect(limiter.getAdaptedRpm()).toBe(6);

      // 3rd 429: 6 * 0.8 = 4.8 -> 5
      limiter.recordRateLimit();
      expect(limiter.getAdaptedRpm()).toBe(5);

      // 4th 429: 5 * 0.8 = 4.0 -> 4
      limiter.recordRateLimit();
      expect(limiter.getAdaptedRpm()).toBe(4);

      // 5th 429: 4 * 0.8 = 3.2 -> 3
      limiter.recordRateLimit();
      expect(limiter.getAdaptedRpm()).toBe(3);

      // 6th 429: 3 * 0.8 = 2.4 -> 2
      limiter.recordRateLimit();
      expect(limiter.getAdaptedRpm()).toBe(2);

      // 7th 429: 2 * 0.8 = 1.6 -> 2 (floor is 2)
      limiter.recordRateLimit();
      expect(limiter.getAdaptedRpm()).toBe(2);
    });

    it("recovers step-by-step (+1) on consecutive successful usages up to config RPM", () => {
      const limiter = new SmartRateLimiter({ rpm: 5 });
      limiter.recordRateLimit(); // 5 * 0.8 = 4
      expect(limiter.getAdaptedRpm()).toBe(4);

      limiter.recordRateLimit(); // 4 * 0.8 = 3
      expect(limiter.getAdaptedRpm()).toBe(3);

      limiter.recordUsage(10); // 3 + 1 = 4
      expect(limiter.getAdaptedRpm()).toBe(4);

      limiter.recordUsage(10); // 4 + 1 = 5
      expect(limiter.getAdaptedRpm()).toBe(5);

      limiter.recordUsage(10); // Remains at 5
      expect(limiter.getAdaptedRpm()).toBe(5);
    });

    it("resets adapted RPM back to config default after 30s of inactivity", async () => {
      vi.useFakeTimers();
      try {
        const limiter = new SmartRateLimiter({ rpm: 20 });
        limiter.recordRateLimit(); // 20 * 0.8 = 16
        expect(limiter.getAdaptedRpm()).toBe(16);

        // 29 seconds pass
        await vi.advanceTimersByTimeAsync(29000);
        // Call waitForSlot to trigger check - should NOT reset yet
        await limiter.waitForSlot(0);
        expect(limiter.getAdaptedRpm()).toBe(16);

        // 2 more seconds pass (total 31 seconds since last rate limit)
        await vi.advanceTimersByTimeAsync(2000);
        // Call waitForSlot to trigger check - should reset
        await limiter.waitForSlot(0);
        expect(limiter.getAdaptedRpm()).toBe(20);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("Exponential Backoff Retry Delays & Transient Errors", () => {
    it("retries on HTTP 429, 503, 504 and transient errors", async () => {
      const limiter = new SmartRateLimiter({
        rpm: 10,
        retryMaxAttempts: 3,
        retryBaseDelayMs: 1,
      });

      let calls = 0;
      const result = await limiter.retryWithBackoff(async () => {
        calls++;
        if (calls === 1) {
          const err = new Error("Service Unavailable") as any;
          err.status = 503;
          throw err;
        }
        if (calls === 2) {
          const err = new Error("Gateway Timeout") as any;
          err.status = 504;
          throw err;
        }
        if (calls === 3) {
          const err = new Error("Too Many Requests") as any;
          err.status = 429;
          throw err;
        }
        return "success";
      });

      expect(result).toBe("success");
      expect(calls).toBe(4);
    });

    it("does not retry on non-transient errors (e.g. 400 Bad Request)", async () => {
      const limiter = new SmartRateLimiter({
        rpm: 10,
        retryMaxAttempts: 3,
        retryBaseDelayMs: 1,
      });

      let calls = 0;
      await expect(
        limiter.retryWithBackoff(async () => {
          calls++;
          const err = new Error("Bad Request") as any;
          err.status = 400;
          throw err;
        })
      ).rejects.toThrow("Bad Request");

      expect(calls).toBe(1);
    });

    it("correctly parses and respects numeric retry-after values", async () => {
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
            const err = new Error("Rate limit exceeded") as any;
            err.status = 429;
            err.headers = {
              "retry-after": "4", // 4 seconds delay
            };
            throw err;
          }
          return "ok";
        });

        // Check that after 3.9 seconds, it hasn't succeeded yet
        await vi.advanceTimersByTimeAsync(3900);
        expect(calls).toBe(1);

        // Advance to 4.1 seconds total
        await vi.advanceTimersByTimeAsync(200);
        const result = await promise;
        expect(result).toBe("ok");
        expect(calls).toBe(2);
      } finally {
        vi.useRealTimers();
      }
    });

    it("correctly parses and respects HTTP Date retry-after values", async () => {
      vi.useFakeTimers();
      try {
        const limiter = new SmartRateLimiter({
          rpm: 10,
          retryMaxAttempts: 1,
          retryBaseDelayMs: 1,
        });

        const now = 1718987700000;
        vi.setSystemTime(new Date(now));

        // 6 seconds in the future
        const targetTime = new Date(now + 6000);
        const httpDateStr = targetTime.toUTCString();
        let calls = 0;

        const promise = limiter.retryWithBackoff(async () => {
          calls++;
          if (calls === 1) {
            const err = new Error("Rate limit exceeded") as any;
            err.status = 429;
            err.headers = {
              "retry-after": httpDateStr,
            };
            throw err;
          }
          return "ok";
        });

        // 5.9 seconds pass
        await vi.advanceTimersByTimeAsync(5900);
        expect(calls).toBe(1);

        // 0.2 more seconds pass (6.1 seconds total)
        await vi.advanceTimersByTimeAsync(200);
        const result = await promise;
        expect(result).toBe("ok");
        expect(calls).toBe(2);
      } finally {
        vi.useRealTimers();
      }
    });

    it("returns 0 delay if HTTP Date retry-after date is in the past", async () => {
      vi.useFakeTimers();
      try {
        const limiter = new SmartRateLimiter({
          rpm: 10,
          retryMaxAttempts: 1,
          retryBaseDelayMs: 1,
        });

        const now = 1718987700000;
        vi.setSystemTime(new Date(now));

        // 10 seconds in the past
        const targetTime = new Date(now - 10000);
        const httpDateStr = targetTime.toUTCString();
        let calls = 0;

        const promise = limiter.retryWithBackoff(async () => {
          calls++;
          if (calls === 1) {
            const err = new Error("Rate limit exceeded") as any;
            err.status = 429;
            err.headers = {
              "retry-after": httpDateStr,
            };
            throw err;
          }
          return "ok";
        });

        // Delay should be 0, so it retries immediately
        await vi.advanceTimersByTimeAsync(10);
        const result = await promise;
        expect(result).toBe("ok");
        expect(calls).toBe(2);
      } finally {
        vi.useRealTimers();
      }
    });

    it("falls back to exponential backoff when retry-after header is invalid", async () => {
      vi.useFakeTimers();
      try {
        const limiter = new SmartRateLimiter({
          rpm: 10,
          retryMaxAttempts: 1,
          retryBaseDelayMs: 1000,
        });

        let calls = 0;
        const promise = limiter.retryWithBackoff(async () => {
          calls++;
          if (calls === 1) {
            const err = new Error("Rate limit exceeded") as any;
            err.status = 429;
            err.headers = {
              "retry-after": "invalid-format-string",
            };
            throw err;
          }
          return "ok";
        });

        // Base delay is 1000ms. Math.pow(2, 0) * 1000 = 1000ms.
        // Plus jitter (up to 300ms).
        // Let's verify it retries after advancing timers by 1500ms.
        await vi.advanceTimersByTimeAsync(1500);
        const result = await promise;
        expect(result).toBe("ok");
        expect(calls).toBe(2);
      } finally {
        vi.useRealTimers();
      }
    });

    it("handles alternate error properties for retry after", async () => {
      vi.useFakeTimers();
      try {
        const limiter = new SmartRateLimiter({
          rpm: 10,
          retryMaxAttempts: 1,
          retryBaseDelayMs: 1,
        });

        let calls = 0;
        const promise1 = limiter.retryWithBackoff(async () => {
          calls++;
          if (calls === 1) {
            const err = new Error("Rate limit exceeded") as any;
            err.status = 429;
            err.retryAfter = 2; // numeric in seconds
            throw err;
          }
          return "ok";
        });

        await vi.advanceTimersByTimeAsync(2100);
        await expect(promise1).resolves.toBe("ok");

        calls = 0;
        const promise2 = limiter.retryWithBackoff(async () => {
          calls++;
          if (calls === 1) {
            const err = new Error("Rate limit exceeded") as any;
            err.status = 429;
            err["retry-after"] = 3; // numeric in seconds
            throw err;
          }
          return "ok";
        });

        await vi.advanceTimersByTimeAsync(3100);
        await expect(promise2).resolves.toBe("ok");
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("Telemetry Integration", () => {
    it("registers rates limiters globally on creation or manually", () => {
      // Clear registry to avoid interference
      (globalThis as any).agencyProviderLimiters = new Map();

      const limiter1 = new SmartRateLimiter({
        rpm: 100,
        providerId: "challenger-provider-1",
      });

      const registry = (globalThis as any).agencyProviderLimiters;
      expect(registry).toBeDefined();
      expect(registry.get("challenger-provider-1")).toBe(limiter1);

      // Verify manually registering
      const limiter2 = new SmartRateLimiter({ rpm: 50 });
      limiter2.registerProvider("challenger-provider-2");
      expect(registry.get("challenger-provider-2")).toBe(limiter2);

      // Verify utilization details match
      const util = registry.get("challenger-provider-1").getUtilization();
      expect(util.adaptedRpm).toBe(100);
      expect(util.rpmPercent).toBe(0);

      // Clean up after test
      registry.delete("challenger-provider-1");
      registry.delete("challenger-provider-2");
    });
  });
});
