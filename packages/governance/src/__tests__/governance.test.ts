import { describe, expect, it, afterEach } from "vitest";
import { CostGovernor, CostGovernanceCeiling, setModelCostResolver } from "../cost-governance.js";
import { ProviderSupervisor } from "../provider-supervisor.js";

describe("CostGovernor model-cost resolver (catalog pricing)", () => {
  afterEach(() => setModelCostResolver(null));

  it("uses the injected resolver's rates when available", () => {
    setModelCostResolver(() => ({ input: 10, output: 30 })); // $/Mtok
    const gov = new CostGovernor();
    // 1M input @ $10 + 1M output @ $30 = $40
    expect(gov.estimateCost(1_000_000, 1_000_000, "any/model")).toBeCloseTo(40, 5);
  });

  it("falls back to the built-in heuristic table when the resolver returns null", () => {
    setModelCostResolver(() => null);
    const gov = new CostGovernor();
    // opus heuristic: input 15, output 75 → 1M+1M = $90
    expect(gov.estimateCost(1_000_000, 1_000_000, "claude-3-opus")).toBeCloseTo(90, 5);
  });

  it("uses the heuristic table when no resolver is set (default)", () => {
    setModelCostResolver(null);
    const gov = new CostGovernor();
    // default cheap rates 0.15 / 0.60 → $0.75
    expect(gov.estimateCost(1_000_000, 1_000_000, "unknown-model")).toBeCloseTo(0.75, 5);
  });
});

describe("CostGovernor", () => {
  it("should trigger warnings, downgrades, and budget depletion correctly", () => {
    const gov = new CostGovernor(1.00); // $1.00 budget
    
    // Initial state
    let state = gov.getGovernanceState();
    expect(state.accumulatedCost).toBe(0);
    expect(state.warningTriggered).toBe(false);
    expect(state.shouldDowngrade).toBe(false);
    expect(state.isDepleted).toBe(false);

    // Record 50 cents spend -> should warning
    gov.recordSpend(0.50);
    state = gov.getGovernanceState();
    expect(state.accumulatedCost).toBe(0.50);
    expect(state.warningTriggered).toBe(true);
    expect(state.shouldDowngrade).toBe(false);

    // Record another 30 cents (total 80 cents) -> should downgrade
    gov.recordSpend(0.30);
    state = gov.getGovernanceState();
    expect(state.accumulatedCost).toBe(0.80);
    expect(state.shouldDowngrade).toBe(true);
    expect(state.isDepleted).toBe(false);

    // Record another 30 cents (total $1.10) -> depleted
    expect(() => gov.recordSpend(0.30)).toThrow(CostGovernanceCeiling);
    state = gov.getGovernanceState();
    expect(state.isDepleted).toBe(true);
  });

  it("tryReserve atomically reserves within budget and refuses overshoot", () => {
    const gov = new CostGovernor(1.00);
    expect(gov.getRemaining()).toBeCloseTo(1.00, 4);

    // Fits → reserved and recorded
    expect(gov.tryReserve(0.60)).toBe(true);
    expect(gov.getRemaining()).toBeCloseTo(0.40, 4);

    // Would overshoot the ceiling → refused, NOTHING recorded (no overspend)
    expect(gov.tryReserve(0.60)).toBe(false);
    expect(gov.getRemaining()).toBeCloseTo(0.40, 4);
    expect(gov.getGovernanceState().accumulatedCost).toBeCloseTo(0.60, 4);

    // Exactly fits the remainder → reserved
    expect(gov.tryReserve(0.40)).toBe(true);
    expect(gov.getRemaining()).toBe(0);

    // Negative is rejected without effect
    expect(gov.tryReserve(-1)).toBe(false);
  });

  it("should estimate cost based on token counts", () => {
    const gov = new CostGovernor(5.00);
    gov.recordTokens(100_000, 20_000, "claude-3-5-sonnet");
    
    const state = gov.getGovernanceState();
    // Sonnet cost: 100k * 3/1M ($0.30) + 20k * 15/1M ($0.30) = $0.60
    expect(state.accumulatedCost).toBeCloseTo(0.60, 4);
  });
});

describe("ProviderSupervisor", () => {
  it("should failover to alternate when primary has high failure rate", () => {
    const supervisor = new ProviderSupervisor("anthropic", ["openai", "gemini"]);
    
    // Initial optimal
    expect(supervisor.getOptimalProvider("anthropic")).toBe("anthropic");

    // Record 3 failures on anthropic
    supervisor.recordCall("anthropic", 1000, false);
    supervisor.recordCall("anthropic", 1000, false);
    supervisor.recordCall("anthropic", 1000, false);

    // Should now route failover to openai
    expect(supervisor.getOptimalProvider("anthropic")).toBe("openai");
  });
});
