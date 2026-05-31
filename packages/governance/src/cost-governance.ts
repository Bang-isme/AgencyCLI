export class CostGovernanceCeiling extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CostGovernanceCeiling";
  }
}

export interface CostState {
  accumulatedCost: number;
  budgetLimit: number;
  percentage: number;
  shouldDowngrade: boolean;
  isDepleted: boolean;
  warningTriggered: boolean;
}

/** Resolves a model's USD-per-1M-token rates, or null when unknown. */
export type ModelCostResolver = (
  modelId: string
) => { input: number; output: number } | null | undefined;

// Module-level hook set by the host (core bootstrap) from the model catalog, so
// `estimateCost` can use real per-model pricing for ANY model the user brings
// (BYOK) instead of the small built-in heuristic table. governance can't import
// the catalog directly (that would be a dependency cycle), hence the setter.
let modelCostResolver: ModelCostResolver | null = null;

export function setModelCostResolver(resolver: ModelCostResolver | null): void {
  modelCostResolver = resolver;
}

export class CostGovernor {
  private accumulatedCost = 0;
  private budgetLimit = 5.00; // default $5.00 USD
  private warningTriggered = false;
  private downgradeTriggered = false;

  constructor(budgetLimit?: number) {
    if (budgetLimit !== undefined && budgetLimit > 0) {
      this.budgetLimit = budgetLimit;
    }
  }

  /**
   * Records a monetary spend in USD.
   */
  recordSpend(amount: number): void {
    this.accumulatedCost += amount;
    if (this.accumulatedCost >= this.budgetLimit) {
      throw new CostGovernanceCeiling(`Cost ceiling exceeded: spent $${this.accumulatedCost.toFixed(4)} / limit $${this.budgetLimit.toFixed(2)}`);
    }
  }

  /**
   * Remaining budget in USD (never negative).
   */
  getRemaining(): number {
    return Math.max(0, this.budgetLimit - this.accumulatedCost);
  }

  /**
   * Atomically reserves `amount` against the budget. Returns true and records
   * the spend if it fits without exceeding the ceiling; returns false and
   * records nothing otherwise. Unlike {@link recordSpend} this never overshoots
   * the ceiling — use it for pre-flight reservation before launching parallel
   * work so concurrent dispatches cannot collectively blow the budget.
   */
  tryReserve(amount: number): boolean {
    if (amount < 0) return false;
    if (this.accumulatedCost + amount > this.budgetLimit) {
      return false;
    }
    this.accumulatedCost += amount;
    return true;
  }

  /**
   * Records a token count and estimates cost based on active model rates.
   */
  recordTokens(inputTokens: number, outputTokens: number, modelId: string): void {
    const cost = this.estimateCost(inputTokens, outputTokens, modelId);
    this.recordSpend(cost);
  }

  /**
   * Retrieves the current governance state.
   */
  getGovernanceState(): CostState {
    const percentage = (this.accumulatedCost / this.budgetLimit) * 100;
    
    if (percentage >= 50 && !this.warningTriggered) {
      this.warningTriggered = true;
      console.warn(`[Telemetry] Cost governance warning: spent ${percentage.toFixed(1)}% of budget ($${this.accumulatedCost.toFixed(4)} / $${this.budgetLimit.toFixed(2)})`);
    }

    if (percentage >= 75 && !this.downgradeTriggered) {
      this.downgradeTriggered = true;
      console.warn(`[Telemetry] Cost governance downgrade trigger: spent ${percentage.toFixed(1)}% of budget ($${this.accumulatedCost.toFixed(4)} / $${this.budgetLimit.toFixed(2)}). Switching to fallback lightweight models.`);
    }

    return {
      accumulatedCost: this.accumulatedCost,
      budgetLimit: this.budgetLimit,
      percentage,
      shouldDowngrade: percentage >= 75,
      isDepleted: percentage >= 100,
      warningTriggered: this.warningTriggered,
    };
  }

  /**
   * Set a new budget limit.
   */
  setBudgetLimit(limit: number): void {
    if (limit > 0) {
      this.budgetLimit = limit;
      this.warningTriggered = false;
      this.downgradeTriggered = false;
    }
  }

  /**
   * Estimate cost in USD based on model rates per 1M tokens.
   *
   * Pure — records nothing. Safe to call for event attribution / forensics
   * (e.g. tagging a `subagent:finished` event with its `costUsd`) without
   * touching the live budget. Use {@link recordTokens} when you actually want
   * to charge the budget.
   */
  estimateCost(inputTokens: number, outputTokens: number, modelId: string): number {
    // 1. Real per-model pricing from the catalog (BYOK-accurate), when wired.
    try {
      const rates = modelCostResolver?.(modelId);
      if (rates && typeof rates.input === "number" && typeof rates.output === "number") {
        return (inputTokens / 1_000_000) * rates.input + (outputTokens / 1_000_000) * rates.output;
      }
    } catch {
      /* fall through to the built-in heuristic table */
    }

    const lowerModel = modelId.toLowerCase();

    // 2. Fallback: built-in heuristic rates per 1M tokens (Input / Output).
    let inputRate = 0.15; // default cheap rates
    let outputRate = 0.60;

    if (lowerModel.includes("claude-3-opus") || lowerModel.includes("opus")) {
      inputRate = 15.00;
      outputRate = 75.00;
    } else if (lowerModel.includes("claude-3-5-sonnet") || lowerModel.includes("sonnet")) {
      inputRate = 3.00;
      outputRate = 15.00;
    } else if (lowerModel.includes("gpt-4o") || lowerModel.includes("gpt-4-turbo")) {
      inputRate = 5.00;
      outputRate = 15.00;
    } else if (lowerModel.includes("gemini-1.5-pro") || lowerModel.includes("gemini-pro")) {
      inputRate = 1.25;
      outputRate = 5.00;
    } else if (lowerModel.includes("gemini-1.5-flash") || lowerModel.includes("flash")) {
      inputRate = 0.075;
      outputRate = 0.30;
    }

    const inputCost = (inputTokens / 1_000_000) * inputRate;
    const outputCost = (outputTokens / 1_000_000) * outputRate;
    return inputCost + outputCost;
  }
}
