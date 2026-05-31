import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parsePlanTasks, runPlan } from "../task/runner.js";
import { ConvergenceEngine } from "../task/convergence-engine.js";
import { loadCheckpoint, saveCheckpoint, TaskCheckpoint } from "../task/checkpoint.js";
import { DagTaskNode } from "@agency/contracts";

const SAMPLE_PLAN = `# Autonomous Run Plan
### Task 1: Scrape monorepo
- [ ] Root configuration
### Task 2: Compile package
- [ ] Direct package compile
`;

describe("Autonomous Execution Convergence Chaos & Torture Tests", () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), "agency-chaos-"));
  });

  afterEach(() => {
    if (projectRoot && existsSync(projectRoot)) {
      rmSync(projectRoot, { recursive: true, force: true });
    }
    vi.restoreAllMocks();
  });

  it("prevents infinite retries and aborts at Level 6 when stagnation is critical", async () => {
    const planPath = join(projectRoot, "plan.md");
    writeFileSync(planPath, SAMPLE_PLAN, "utf8");

    // Set environment flag to force gate failure in the runner
    process.env.AGENCY_TEST_FORCE_GATE_FAIL = "true";

    vi.spyOn(await import("../router/model-router.js"), "routeUserPrompt").mockResolvedValue({
      suggested_agent: "planner"
    } as any);

    vi.spyOn(await import("../agents/orchestrator.js"), "dispatchAgent").mockResolvedValue({
      agentId: "planner",
      exitCode: 0,
      stdout: "",
      stderr: "",
      isolatedEnv: {},
      payload: {
        agentId: "planner",
        task: "mocked task",
        coordinatorRoute: {} as any,
        subagentRoute: null,
        suggestedCommands: [],
        disciplines: [],
        agentPromptPath: null,
        subagentStdout: "",
        subagentStderr: "",
        filesWritten: []
      }
    });

    await expect(
      runPlan(projectRoot, planPath, {
        gateEvery: 0,
        maxAttempts: 10,
        onTaskStart: (task, agent, attempt) => {
          // No-op start
        }
      })
    ).rejects.toThrow("Stagnation critical");

    // Check if post-mortem log was generated cleanly
    const postmortemPath = join(projectRoot, ".agency", "autonomous-postmortem.log");
    expect(existsSync(postmortemPath)).toBe(true);

    const data = JSON.parse(readFileSync(postmortemPath, "utf8"));
    expect(data.stagnationScore).toBeGreaterThanOrEqual(0.8);
    expect(data.error).toContain("TypeScript compile error");
  });

  it("handles causal mutations, creates WAL entries and successfully performs rollbacks", async () => {
    const fileToMutate = join(projectRoot, "index.ts");
    writeFileSync(fileToMutate, "const initial = 1;", "utf8");

    const state = {
      taskId: "test-run",
      objective: "Test rollback behavior",
      executionFrontier: [],
      completedOperations: [],
      failedOperations: [],
      pendingOperations: [],
      verificationResults: [],
      retryHistory: [],
      buildFailures: [],
      fileMutationGraph: [
        {
          file: "index.ts",
          operationId: "op-1",
          causalParent: "task-1",
          mutationHash: "hash-new",
          beforeSnapshotHash: "hash-old",
          afterSnapshotHash: "hash-new",
          verificationImpact: [],
          rollbackCheckpointId: "task-1",
          originalContent: "const initial = 1;",
          newContent: "const initial = 2;"
        }
      ],
      convergenceScore: 1.0,
      stagnationScore: 0.0,
      checkpoints: [],
      replayLog: []
    };

    // Apply mutation content physically
    writeFileSync(fileToMutate, "const initial = 2;", "utf8");

    // Execute causal rollback
    const reverted = await ConvergenceEngine.applyCausalRollback(projectRoot, state, "task-1");
    expect(reverted).toEqual(["index.ts"]);

    // Verify physical file content restored to initial state
    expect(readFileSync(fileToMutate, "utf8")).toBe("const initial = 1;");
    expect(state.fileMutationGraph.length).toBe(0);
  });

  afterEach(() => {
    delete process.env.AGENCY_TEST_FORCE_GATE_FAIL;
  });

  it("consolidates deltas and triggers delta compaction when mutations count > 20", () => {
    const cp: TaskCheckpoint = {
      id: "compaction-test",
      planPath: "plan.md",
      currentTask: 1,
      completed: [],
      status: "running",
      updatedAt: new Date().toISOString(),
      executionState: {
        taskId: "compaction-test",
        objective: "Test delta compaction",
        executionFrontier: [],
        completedOperations: [],
        failedOperations: [],
        pendingOperations: [],
        verificationResults: [],
        retryHistory: [],
        buildFailures: [],
        fileMutationGraph: Array.from({ length: 25 }, (_, i) => ({
          file: "index.ts",
          operationId: `op-${i}`,
          causalParent: "task-1",
          mutationHash: `hash-${i}`,
          beforeSnapshotHash: i === 0 ? "hash-old" : `hash-${i-1}`,
          afterSnapshotHash: `hash-${i}`,
          verificationImpact: [],
          rollbackCheckpointId: "task-1",
          originalContent: i === 0 ? "const initial = 0;" : `const initial = ${i};`,
          newContent: `const initial = ${i+1};`
        })),
        convergenceScore: 1.0,
        stagnationScore: 0.0,
        checkpoints: [],
        replayLog: []
      }
    };

    // Trigger delta compaction
    ConvergenceEngine.compactDeltas(cp);

    // Verify delta mutation array is compacted to only a single mutation containing the ultimate oldest initialContent
    expect(cp.executionState?.fileMutationGraph.length).toBe(1);
    expect(cp.executionState?.fileMutationGraph[0]?.originalContent).toBe("const initial = 0;");
    const hasCompactionLog = cp.executionState?.replayLog?.some(l => l.includes("[COMPACTION] Delta mutations compacted at"));
    expect(hasCompactionLog).toBe(true);
  });

  it("calculates structural metrics and convergent score of DAG scheduler state", () => {
    const nodes: Record<string, DagTaskNode> = {
      "task-1": {
        id: "task-1",
        dependencies: [],
        action: "Action 1",
        params: {},
        state: "COMPLETED",
        timeoutMs: 0,
        attempts: 1
      },
      "task-2": {
        id: "task-2",
        dependencies: ["task-1"],
        action: "Action 2",
        params: {},
        state: "PENDING",
        timeoutMs: 0,
        attempts: 2
      },
      "task-3": {
        id: "task-3",
        dependencies: ["task-2"],
        action: "Action 3",
        params: {},
        state: "PENDING",
        timeoutMs: 0,
        attempts: 0
      }
    };

    const metrics = ConvergenceEngine.calculateStructural(nodes);
    expect(metrics.completedObjectiveRatio).toBe(1 / 3);
    expect(metrics.executionFrontierSize).toBe(1); // Only task-2 is ready
    expect(metrics.blockedNodeCount).toBe(1); // task-3 blocked on task-2
    expect(metrics.unresolvedDependencyCount).toBe(1); // dependencies unresolved (task-2 -> task-3 dependency)
  });
});
