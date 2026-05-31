import { describe, expect, it, vi, afterEach, beforeEach } from "vitest";
import { SkillsRegistry, SkillCircuitBreakerError } from "../skill/skills-registry.js";

describe("SkillsRegistry & Circuit Breaker", () => {
  let registry: SkillsRegistry;

  beforeEach(() => {
    registry = SkillsRegistry.getInstance();
    registry.resetSkill("test-tool");
    registry.registerSkill({
      name: "test-tool",
      description: "A tool to test circuit breaking",
    });
  });

  it("registers and retrieves skills successfully", () => {
    const list = registry.listSkills();
    expect(list.some(s => s.name === "test-tool")).toBe(true);

    const s = registry.getSkill("test-tool");
    expect(s?.description).toBe("A tool to test circuit breaking");
  });

  it("executes successfully and resets failure count on success", async () => {
    let callCount = 0;
    const task = async () => {
      callCount++;
      return "success";
    };

    const res = await registry.executeWithCircuitBreaker("test-tool", task);
    expect(res).toBe("success");
    expect(callCount).toBe(1);
    expect(registry.isSkillTripped("test-tool")).toBe(false);
  });

  it("trips circuit after 3 consecutive strict exceptions", async () => {
    const failingTask = async () => {
      throw new Error("Execution crash");
    };

    // Attempt 1
    await expect(registry.executeWithCircuitBreaker("test-tool", failingTask)).rejects.toThrow("Execution crash");
    expect(registry.isSkillTripped("test-tool")).toBe(false);

    // Attempt 2
    await expect(registry.executeWithCircuitBreaker("test-tool", failingTask)).rejects.toThrow("Execution crash");
    expect(registry.isSkillTripped("test-tool")).toBe(false);

    // Attempt 3 -> trips circuit
    await expect(registry.executeWithCircuitBreaker("test-tool", failingTask)).rejects.toThrow("Execution crash");
    expect(registry.isSkillTripped("test-tool")).toBe(true);

    // Attempt 4 -> blocked by circuit breaker
    await expect(registry.executeWithCircuitBreaker("test-tool", failingTask)).rejects.toThrow(SkillCircuitBreakerError);
  });

  it("does NOT trip circuit if failure is a quality validation gate failure", async () => {
    const gateTask = async () => {
      throw new Error("Quality gate failed: lint errors detected");
    };

    // Attempt 1
    await expect(registry.executeWithCircuitBreaker("test-tool", gateTask)).rejects.toThrow("Quality gate failed");
    expect(registry.isSkillTripped("test-tool")).toBe(false);

    // Attempt 2
    await expect(registry.executeWithCircuitBreaker("test-tool", gateTask)).rejects.toThrow("Quality gate failed");
    expect(registry.isSkillTripped("test-tool")).toBe(false);

    // Attempt 3 -> still not tripped
    await expect(registry.executeWithCircuitBreaker("test-tool", gateTask)).rejects.toThrow("Quality gate failed");
    expect(registry.isSkillTripped("test-tool")).toBe(false);
  });

  it("auto-resets circuit breaker after cooldown period", async () => {
    vi.useFakeTimers();
    try {
      const failingTask = async () => {
        throw new Error("Execution crash");
      };

      // Trip circuit
      await expect(registry.executeWithCircuitBreaker("test-tool", failingTask)).rejects.toThrow("Execution crash");
      await expect(registry.executeWithCircuitBreaker("test-tool", failingTask)).rejects.toThrow("Execution crash");
      await expect(registry.executeWithCircuitBreaker("test-tool", failingTask)).rejects.toThrow("Execution crash");
      expect(registry.isSkillTripped("test-tool")).toBe(true);

      // Fast-forward time by 5 minutes and 1 second
      vi.advanceTimersByTime(300_000 + 1000);

      // Circuit should be auto-reset
      expect(registry.isSkillTripped("test-tool")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
