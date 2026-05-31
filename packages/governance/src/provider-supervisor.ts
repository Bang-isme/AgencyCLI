export interface ProviderHealth {
  latencyHistory: number[];
  successCount: number;
  failureCount: number;
}

export class ProviderSupervisor {
  private healthRegistry: Map<string, ProviderHealth> = new Map();
  private primaryProvider = "anthropic";
  private alternateProviders: string[] = ["openai", "gemini"];

  constructor(primary?: string, alternates?: string[]) {
    if (primary) this.primaryProvider = primary;
    if (alternates) this.alternateProviders = alternates;
  }

  getPrimaryProvider(): string {
    return this.primaryProvider;
  }

  /**
   * Records a request duration and status.
   */
  recordCall(providerId: string, durationMs: number, success: boolean): void {
    if (!this.healthRegistry.has(providerId)) {
      this.healthRegistry.set(providerId, {
        latencyHistory: [],
        successCount: 0,
        failureCount: 0,
      });
    }

    const health = this.healthRegistry.get(providerId)!;
    if (success) {
      health.successCount++;
    } else {
      health.failureCount++;
    }
    health.latencyHistory.push(durationMs);
    if (health.latencyHistory.length > 20) {
      health.latencyHistory.shift();
    }
  }

  /**
   * Determines the optimal provider to use, falling back to alternates if the primary is unhealthy.
   */
  getOptimalProvider(requestedProviderId: string): string {
    const health = this.healthRegistry.get(requestedProviderId);
    
    // Fall back if failure rate is high (>50% failures on last 5 calls, or consecutive failures)
    if (health && health.failureCount > 0 && health.successCount + health.failureCount >= 3) {
      const failureRate = health.failureCount / (health.successCount + health.failureCount);
      if (failureRate > 0.5) {
        // Unhealthy! Route to alternates
        for (const alt of this.alternateProviders) {
          const altHealth = this.healthRegistry.get(alt);
          if (!altHealth || altHealth.failureCount === 0) {
            console.warn(`[Supervisor] Primary provider ${requestedProviderId} is unhealthy (failure rate ${Math.round(failureRate * 100)}%). Routing failover to alternate: ${alt}`);
            return alt;
          }
        }
      }
    }

    return requestedProviderId;
  }

  /**
   * Get avg latency for a provider.
   */
  getAverageLatency(providerId: string): number {
    const health = this.healthRegistry.get(providerId);
    if (!health || health.latencyHistory.length === 0) return 0;
    const sum = health.latencyHistory.reduce((a, b) => a + b, 0);
    return sum / health.latencyHistory.length;
  }
}
