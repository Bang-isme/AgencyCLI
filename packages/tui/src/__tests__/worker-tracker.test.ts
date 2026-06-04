import { describe, it, expect } from "vitest";
import { WorkerLifecycleTracker } from "../state/semantic-orchestration.js";

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
});
