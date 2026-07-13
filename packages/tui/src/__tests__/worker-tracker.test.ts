import { describe, it, expect } from "vitest";
import { WorkerLifecycleTracker, SemanticTranslator } from "../state/semantic-orchestration.js";

describe("SemanticTranslator.translatePhase (no shouty raw enum leak)", () => {
  it("maps every WorkerState enum value to a calm sentence-case label", () => {
    const states = [
      "SPAWNING",
      "ACQUIRING_CONTEXT",
      "ANALYZING",
      "MAPPING_DEPENDENCIES",
      "SYNTHESIZING",
      "VERIFYING",
      "SELF_HEALING",
      "CONSOLIDATING",
      "COMPLETED",
      "FAILED",
      "INCOMPLETE",
      "SKIPPED",
      "INTERRUPTED",
    ];
    for (const s of states) {
      const label = SemanticTranslator.translatePhase(s);
      // Never echo the raw uppercase enum back to the user.
      expect(label).not.toBe(s);
      expect(label).not.toMatch(/[A-Z]{2,}/); // no SHOUTY tokens or SNAKE_CASE
    }
  });

  it("still threads a target file into the relevant labels", () => {
    expect(SemanticTranslator.translatePhase("ANALYZING", "auth.ts")).toContain("auth.ts");
    expect(SemanticTranslator.translatePhase("SYNTHESIZING", "auth.ts")).toContain("auth.ts");
  });
});

describe("WorkerLifecycleTracker.finalizeOrphans / reset", () => {
  it("lands a still-running worker on INTERRUPTED (terminal) with active steps downgraded", () => {
    const t = new WorkerLifecycleTracker();
    t.registerWorker("a1", "do work");
    t.transitionWorker("a1", "ANALYZING", "Thinking…", "", { label: "Read file", status: "active" });

    t.finalizeOrphans();

    const w = t.getWorkers().find((x) => x.agentId === "a1")!;
    expect(w.state).toBe("INTERRUPTED");
    // No step left dangling as "active" — the worker is no longer doing anything.
    expect(w.steps.some((s) => s.status === "active")).toBe(false);
  });

  it("leaves already-terminal workers (COMPLETED / FAILED) untouched", () => {
    const t = new WorkerLifecycleTracker();
    t.registerWorker("done1", "x");
    t.transitionWorker("done1", "COMPLETED", "ok");
    t.registerWorker("fail1", "y");
    t.transitionWorker("fail1", "FAILED", "boom");

    t.finalizeOrphans();

    expect(t.getWorkers().find((x) => x.agentId === "done1")!.state).toBe("COMPLETED");
    expect(t.getWorkers().find((x) => x.agentId === "fail1")!.state).toBe("FAILED");
  });

  it("reset() clears all tracked workers so a prior turn does not leak into the next", () => {
    const t = new WorkerLifecycleTracker();
    t.registerWorker("a1", "x");
    t.registerWorker("a2", "y");
    expect(t.getWorkers()).toHaveLength(2);

    t.reset();

    expect(t.getWorkers()).toHaveLength(0);
  });

  it("tracks same-role parallel workers by dispatchId instead of overwriting", () => {
    const t = new WorkerLifecycleTracker();
    t.registerWorker("planner", "first", "planner-1");
    t.registerWorker("planner", "second", "planner-2");
    t.getWorkers().find((w) => w.dispatchId === "planner-2")!.lastStateChange = Date.now() - 1000;

    t.transitionWorker("planner", "COMPLETED", "ok", "", undefined, "planner-2");

    const workers = t.getWorkers();
    expect(workers).toHaveLength(2);
    expect(workers.find((w) => w.dispatchId === "planner-1")!.task).toBe("first");
    expect(workers.find((w) => w.dispatchId === "planner-1")!.state).toBe("SPAWNING");
    expect(workers.find((w) => w.dispatchId === "planner-2")!.state).toBe("COMPLETED");
  });

  it("represents skipped workers as terminal", () => {
    const t = new WorkerLifecycleTracker();
    t.registerWorker("planner", "skip me", "planner-skip");
    t.transitionWorker("planner", "SKIPPED", "budget exhausted", "", undefined, "planner-skip");
    t.finalizeOrphans();

    expect(t.getWorkers()[0]!.state).toBe("SKIPPED");
  });

  it("keeps incomplete workers terminal and distinct from a failure", () => {
    const t = new WorkerLifecycleTracker();
    t.registerWorker("planner", "finish task", "planner-incomplete");
    t.transitionWorker("planner", "INCOMPLETE", "Reached loop limit", "", undefined, "planner-incomplete");
    t.finalizeOrphans();

    expect(t.getWorkers()[0]!.state).toBe("INCOMPLETE");
  });
});
