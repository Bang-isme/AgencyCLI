import { describe, expect, it } from "vitest";
import { PlannerEngine } from "../planner/planner-engine.js";
import { ExecutionContext } from "@agency/contracts";

describe("PlannerEngine Subsystem", () => {
  const planner = new PlannerEngine();

  const makeCtx = (maxAttempts = 3): ExecutionContext => ({
    sessionId: "sess-1",
    traceId: "trace-1",
    workspaceId: "ws-1",
    cancellationToken: { aborted: false },
    governanceContext: {
      tokenBudgetLimit: 1000,
      tokensConsumed: 0,
      costCeilingUsd: 1.0,
      costConsumedUsd: 0,
      maxAttemptsLimit: maxAttempts,
    },
    retrievalScope: [],
    schedulerScope: [],
    sandboxScope: "ws-1",
  });

  it("should execute a simple serial DAG successfully", async () => {
    const tasks = [
      { id: "task-1", dependencies: [], action: "action-1", params: {}, timeoutMs: 5000 },
      { id: "task-2", dependencies: ["task-1"], action: "action-2", params: {}, timeoutMs: 5000 },
    ];
    const dag = planner.createDag(tasks);

    const executedOrder: string[] = [];
    await planner.execute(dag, makeCtx(), async (node) => {
      executedOrder.push(node.id);
      return `result-for-${node.id}`;
    });

    expect(executedOrder).toEqual(["task-1", "task-2"]);
    expect(dag.nodes["task-1"].state).toBe("COMPLETED");
    expect(dag.nodes["task-2"].state).toBe("COMPLETED");
  });

  it("should execute independent tasks in parallel and respect dependencies", async () => {
    const tasks = [
      { id: "task-1", dependencies: [], action: "action-1", params: {}, timeoutMs: 5000 },
      { id: "task-2", dependencies: [], action: "action-2", params: {}, timeoutMs: 5000 },
      { id: "task-3", dependencies: ["task-1", "task-2"], action: "action-3", params: {}, timeoutMs: 5000 },
    ];
    const dag = planner.createDag(tasks);

    const executed: string[] = [];
    await planner.execute(dag, makeCtx(), async (node) => {
      // Simulate some asynchronous work
      await new Promise((resolve) => setTimeout(resolve, 50));
      executed.push(node.id);
      return `result-for-${node.id}`;
    });

    expect(executed.slice(0, 2)).toContain("task-1");
    expect(executed.slice(0, 2)).toContain("task-2");
    expect(executed[2]).toBe("task-3");
  });

  it("should retry failed tasks up to max attempts, then run rollbacks", async () => {
    const tasks = [
      { id: "task-1", dependencies: [], action: "action-1", params: {}, timeoutMs: 5000 },
      { id: "task-2", dependencies: ["task-1"], action: "action-2", params: {}, timeoutMs: 5000 },
    ];
    // Define rollback actions
    const rollbackPaths = {
      "task-1": ["rollback-action-1"],
    };

    const dag = planner.createDag(tasks, rollbackPaths);
    const executedAttempts: Record<string, number> = {};
    const rollbacksRun: string[] = [];

    let attemptFunc = async (node: any) => {
      executedAttempts[node.id] = (executedAttempts[node.id] || 0) + 1;
      if (node.id === "task-2") {
        throw new Error("Simulated task 2 failure");
      }
      if (node.action === "rollback-action-1") {
        rollbacksRun.push(node.id);
      }
      return "ok";
    };

    await expect(planner.execute(dag, makeCtx(2), attemptFunc)).rejects.toThrow("Simulated task 2 failure");

    expect(executedAttempts["task-1"]).toBe(1);
    expect(executedAttempts["task-2"]).toBe(2); // Retried twice
    expect(dag.nodes["task-1"].state).toBe("COMPLETED");
    expect(dag.nodes["task-2"].state).toBe("FAILED");
    expect(rollbacksRun).toContain("rollback-task-1-rollback-action-1");
  });
});
