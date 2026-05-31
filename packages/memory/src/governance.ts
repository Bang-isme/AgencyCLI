import { QueryOptions } from "./types.js";

export class MemoryBudgetAllocator {
  private maxHeapLimitBytes: number;

  constructor(maxHeapLimitMb = 512) {
    this.maxHeapLimitBytes = maxHeapLimitMb * 1024 * 1024;
  }

  /**
   * Evaluates heap allocation space dynamically and calculates target limits
   */
  public allocateBudget(): { cacheLimit: number; retrievalCeiling: number } {
    const mem = process.memoryUsage();
    const ratio = mem.heapUsed / this.maxHeapLimitBytes;

    if (ratio > 0.85) {
      // Emergency mode: restrict allocations significantly
      return {
        cacheLimit: 50,
        retrievalCeiling: 250, // very tight token packing limit
      };
    } else if (ratio > 0.6) {
      // Warn mode: partial conservation
      return {
        cacheLimit: 200,
        retrievalCeiling: 800,
      };
    }

    // Healthy standard defaults
    return {
      cacheLimit: 1000,
      retrievalCeiling: 4000,
    };
  }
}

export class CapabilityNegotiator {
  /**
   * Adapts query options dynamically depending on model capacity levels
   */
  public negotiate(
    modelName: string,
    baseOptions: QueryOptions
  ): QueryOptions {
    const isWeakModel =
      modelName.includes("flash") ||
      modelName.includes("gpt-3.5") ||
      modelName.includes("llama-3-8b") ||
      modelName.includes("haiku");

    if (isWeakModel) {
      // Weak models: restrict limits to avoid context overload
      return {
        ...baseOptions,
        limit: Math.min(baseOptions.limit ?? 5, 5),
        maxTokens: Math.min(baseOptions.maxTokens ?? 1000, 1000),
      };
    }

    // Strong model defaults
    return {
      ...baseOptions,
      limit: baseOptions.limit ?? 15,
      maxTokens: baseOptions.maxTokens ?? 4000,
    };
  }
}
