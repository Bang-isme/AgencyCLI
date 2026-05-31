import { isTransientError } from "./utils/errors.js";

// ---------------------------------------------------------------------------
// Smart Rate Limiter
//
// Sliding-window tracker with adaptive throttling, exponential backoff
// and jitter for safe API usage — especially for free-tier keys.
// ---------------------------------------------------------------------------


export interface RateLimitConfig {
  /** Requests per minute allowed. */
  rpm: number;
  /** Tokens per minute allowed (0 = unlimited). */
  tpm: number;
  /** Max retry attempts on 429/rate-limit errors. */
  retryMaxAttempts: number;
  /** Base delay in ms for exponential backoff. */
  retryBaseDelayMs: number;
}

const DEFAULT_CONFIG: RateLimitConfig = {
  rpm: 60,
  tpm: 0,
  retryMaxAttempts: 8,
  retryBaseDelayMs: 1000,
};

export interface RateLimitUtilization {
  /** Current RPM utilization (0-100). */
  rpmPercent: number;
  /** Current TPM utilization (0-100), or null if unlimited. */
  tpmPercent: number | null;
  /** Whether we are currently throttling. */
  throttled: boolean;
}

interface TimestampedEntry {
  ts: number;
  tokens: number;
}

export class SmartRateLimiter {
  private config: RateLimitConfig;
  private entries: TimestampedEntry[] = [];
  private throttled = false;
  /** Track consecutive 429s to adaptively lower limits. */
  private consecutive429s = 0;
  private adaptedRpm: number;

  constructor(config?: Partial<RateLimitConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.adaptedRpm = this.config.rpm;
  }

  /** Purge entries older than 60 seconds. */
  private purgeOld(): void {
    const cutoff = Date.now() - 60_000;
    this.entries = this.entries.filter((e) => e.ts > cutoff);
  }

  /** Current requests in the last 60 seconds. */
  private currentRpm(): number {
    this.purgeOld();
    return this.entries.length;
  }

  /** Current tokens in the last 60 seconds. */
  private currentTpm(): number {
    this.purgeOld();
    return this.entries.reduce((sum, e) => sum + e.tokens, 0);
  }

  /**
   * Wait until there is a slot available.
   * If we're near the limit, introduces a proportional delay
   * to spread requests evenly (prevents burst + stall patterns).
   */
  async waitForSlot(estimatedTokens = 0): Promise<void> {
    this.purgeOld();
    const currentRpm = this.currentRpm();
    const headroom = this.adaptedRpm - currentRpm;

    if (headroom <= 0) {
      // Must wait for oldest entry to expire
      this.throttled = true;
      const oldest = this.entries[0];
      if (oldest) {
        const waitMs = oldest.ts + 60_000 - Date.now() + 100; // +100ms safety
        if (waitMs > 0) {
          await sleep(waitMs);
        }
      }
      this.throttled = false;
      return;
    }

    // Spread requests: if usage > 70%, add proportional delay
    const utilization = currentRpm / this.adaptedRpm;
    if (utilization > 0.7) {
      const spreadMs = Math.round((60_000 / this.adaptedRpm) * (utilization - 0.5));
      if (spreadMs > 50) {
        this.throttled = true;
        await sleep(spreadMs);
        this.throttled = false;
      }
    }

    // TPM check
    if (this.config.tpm > 0) {
      const currentTpm = this.currentTpm();
      if (currentTpm + estimatedTokens > this.config.tpm) {
        this.throttled = true;
        const oldest = this.entries[0];
        if (oldest) {
          const waitMs = oldest.ts + 60_000 - Date.now() + 200;
          if (waitMs > 0) await sleep(waitMs);
        }
        this.throttled = false;
      }
    }
  }

  /** Record a completed API call. */
  recordUsage(tokens: number): void {
    this.entries.push({ ts: Date.now(), tokens });
    // Reset consecutive 429 counter on success
    this.consecutive429s = 0;
  }

  /** Called when a 429 is received — adapt limits downward. */
  recordRateLimit(): void {
    this.consecutive429s += 1;
    // Adaptive: lower effective RPM by 20% per consecutive 429, floor at 2
    this.adaptedRpm = Math.max(2, Math.round(this.adaptedRpm * 0.8));
  }

  /** Reset adaptive limits (e.g. after config change). */
  resetAdaptation(): void {
    this.consecutive429s = 0;
    this.adaptedRpm = this.config.rpm;
  }

  /**
   * Retry a function with exponential backoff + jitter on rate limit or temporary server errors.
   * Detects rate limits via HTTP status codes or message keywords.
   */
  async retryWithBackoff<T>(fn: () => Promise<T>): Promise<T> {
    let lastError: unknown;
    const maxAttempts = this.config.retryMaxAttempts;
    for (let attempt = 0; attempt <= maxAttempts; attempt++) {
      try {
        await this.waitForSlot();
        const result = await fn();
        this.consecutive429s = 0;
        return result;
      } catch (err: any) {
        lastError = err;
        const isRateLimit = isTransientError(err);

        if (!isRateLimit || attempt === maxAttempts) {
          throw err;
        }

        this.recordRateLimit();
        const baseDelay = this.config.retryBaseDelayMs * Math.pow(2, attempt);
        const jitter = Math.random() * baseDelay * 0.3;
        const finalDelay = baseDelay + jitter;

        const seconds = (finalDelay / 1000).toFixed(1);
        const warningMsg = `⚠️ [Rate Limit / Transient Error] LLM request failed. Attempt ${attempt + 1}/${maxAttempts + 1}. Retrying in ${seconds}s (Adapted RPM: ${this.adaptedRpm})...`;
        if (typeof (globalThis as any).onAgencyProviderWarning === "function") {
          (globalThis as any).onAgencyProviderWarning(warningMsg);
        } else {
          console.warn(`\x1b[33m${warningMsg}\x1b[0m`);
        }

        await sleep(finalDelay);
      }
    }
    throw lastError;
  }

  /** Current utilization stats. */
  getUtilization(): RateLimitUtilization {
    this.purgeOld();
    return {
      rpmPercent: Math.round((this.currentRpm() / this.adaptedRpm) * 100),
      tpmPercent: this.config.tpm > 0
        ? Math.round((this.currentTpm() / this.config.tpm) * 100)
        : null,
      throttled: this.throttled,
    };
  }

  /** Whether rate limiter is actively throttling right now. */
  isThrottled(): boolean {
    return this.throttled;
  }

  /** Current adapted RPM (may be lower than config after 429s). */
  getAdaptedRpm(): number {
    return this.adaptedRpm;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
