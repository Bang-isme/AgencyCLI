import { describe, expect, it, beforeEach } from "vitest";
import {
  CapabilityAgentRegistry,
  inferCapabilities,
} from "../agents/agent-registry.js";

const registry = CapabilityAgentRegistry.getInstance();

beforeEach(() => {
  registry.reset();
});

describe("inferCapabilities", () => {
  it("extracts capability keywords from free-text tasks", () => {
    const caps = inferCapabilities("Fix the failing vitest unit test for the login endpoint");
    expect(caps).toContain("test");
    expect(caps).toContain("vitest");
    expect(caps).toContain("unit");
    expect(caps).toContain("endpoint");
  });

  it("returns an empty list when the task gives no signal", () => {
    expect(inferCapabilities("do the thing")).toEqual([]);
    expect(inferCapabilities("")).toEqual([]);
  });
});

describe("CapabilityAgentRegistry.rankForTask", () => {
  it("ranks the agent with the most capability overlap first", () => {
    const ranked = registry.rankForTask({
      capabilities: ["test", "vitest", "coverage"],
      clearance: 0,
    });
    expect(ranked[0]!.id).toBe("test-engineer");
  });

  it("excludes agents below the required clearance", () => {
    const ranked = registry.rankForTask({
      capabilities: ["test"],
      clearance: 3, // HIGH
    });
    // test-engineer is LOW clearance → must be filtered out
    expect(ranked.some((d) => d.id === "test-engineer")).toBe(false);
    expect(ranked.every((d) => d.clearanceLevel >= 3)).toBe(true);
  });

  it("prefers a healthier agent when capability overlap ties", () => {
    // security-auditor and planner are both HIGH; give planner a failure record
    // and a no-capability need so overlap ties at 0 → success rate decides.
    registry.recordOutcome("planner", false, "boom");
    const ranked = registry.rankForTask({ capabilities: [], clearance: 3 });
    const plannerIdx = ranked.findIndex((d) => d.id === "planner");
    const auditorIdx = ranked.findIndex((d) => d.id === "security-auditor");
    expect(auditorIdx).toBeLessThan(plannerIdx);
  });

  it("penalizes a saturated agent in favour of an idle peer", () => {
    // Saturate test-engineer; debugger also matches "fix" but not "test".
    registry.markInFlight("test-engineer", "t1");
    registry.markInFlight("test-engineer", "t2");
    registry.markInFlight("test-engineer", "t3"); // inFlight 3 / max 3
    const ranked = registry.rankForTask({ capabilities: ["test"], clearance: 0 });
    // Still ranked (it's the only "test" match) but its score is reduced by load.
    const te = registry.describe("test-engineer")!;
    expect(te.utilization.inFlight).toBe(3);
    expect(ranked[0]!.id).toBe("test-engineer");
  });
});

describe("CapabilityAgentRegistry.recordOutcome / utilization", () => {
  it("tracks success and failure counts plus lastError", () => {
    registry.recordOutcome("coder" as any, true); // unknown id → no throw, no-op
    registry.recordOutcome("backend-specialist", true);
    registry.recordOutcome("backend-specialist", false, "db down");
    const d = registry.describe("backend-specialist")!;
    expect(d.health.successCount).toBe(1);
    expect(d.health.failureCount).toBe(1);
    expect(d.health.lastError).toBe("db down");
    expect(d.health.lastSeen).toBeGreaterThan(0);
  });

  it("increments and decrements in-flight load, clamping at zero", () => {
    registry.markInFlight("debugger", "investigate crash");
    let d = registry.describe("debugger")!;
    expect(d.utilization.inFlight).toBe(1);
    expect(d.utilization.currentTask).toBe("investigate crash");

    registry.markDone("debugger");
    d = registry.describe("debugger")!;
    expect(d.utilization.inFlight).toBe(0);
    expect(d.utilization.currentTask).toBeNull();

    // extra markDone must not go negative
    registry.markDone("debugger");
    expect(registry.describe("debugger")!.utilization.inFlight).toBe(0);
  });
});

describe("CapabilityAgentRegistry.resolveAgentForTask", () => {
  it("reroutes to a strictly-better capability match", () => {
    const res = registry.resolveAgentForTask({
      requested: "test-engineer",
      task: "Design the system architecture and roadmap for the new service",
    });
    expect(res.rerouted).toBe(true);
    expect(res.agentId).toBe("planner");
    expect(res.matched).toContain("architecture");
  });

  it("keeps the requested agent when it is already the best fit", () => {
    const res = registry.resolveAgentForTask({
      requested: "test-engineer",
      task: "Add vitest unit test coverage for the parser",
    });
    expect(res.rerouted).toBe(false);
    expect(res.agentId).toBe("test-engineer");
  });

  it("keeps the requested agent when the task has no capability signal", () => {
    const res = registry.resolveAgentForTask({
      requested: "test-engineer",
      task: "handle it",
    });
    expect(res.rerouted).toBe(false);
    expect(res.agentId).toBe("test-engineer");
    expect(res.reason).toBe("no-capability-signal");
  });

  it("does not reroute an unmodeled (custom) agent", () => {
    const res = registry.resolveAgentForTask({
      requested: "my-custom-agent" as any,
      task: "Write vitest tests for everything",
    });
    expect(res.rerouted).toBe(false);
    expect(res.agentId).toBe("my-custom-agent");
    expect(res.reason).toBe("unmodeled-agent");
  });
});
