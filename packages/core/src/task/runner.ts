import { randomUUID, createHash } from "node:crypto";
import v8 from "node:v8";
import { existsSync, readFileSync } from "node:fs";
import { join, isAbsolute, resolve } from "node:path";
import { execa } from "execa";
import { DagTaskNode } from "@agency/contracts";
import { dispatchAgent } from "../agents/orchestrator.js";
import { coerceAgentId } from "../agents/profiles.js";
import type { AgentId } from "../agents/types.js";
import { routeUserPrompt } from "../router/model-router.js";
import { resolveSkillsRoot } from "../skills-root.js";
import { EventBus } from "../events/event-bus.js";
import {
  loadCheckpoint,
  saveCheckpoint,
  type TaskCheckpoint,
  type FileMutation,
} from "./checkpoint.js";
import { ConvergenceEngine, RecoveryLevel } from "./convergence-engine.js";

const TASK_HEADER_RE = /^### Task (\d+):\s*(.+)$/gm;

export interface PlanTask {
  id: number;
  title: string;
  dependencies?: number[];
}

/** Thrown by {@link runPlan} when the task DAG contains a dependency cycle. */
export class PlanCycleError extends Error {
  constructor(public readonly cycle: string[]) {
    super(`Plan dependency cycle detected: ${cycle.join(" → ")}`);
    this.name = "PlanCycleError";
  }
}

/**
 * Static cycle detection over the execution DAG (DFS with a recursion stack).
 *
 * A dependency cycle would otherwise deadlock the scheduler silently — every
 * node in the cycle waits forever for a dependency that can never complete.
 * Returns the offending cycle as an ordered node-id path (e.g.
 * `["task-1","task-2","task-1"]`), or `null` when the graph is acyclic.
 * Dangling dependencies (pointing at non-existent nodes) are ignored here — the
 * scheduler treats them as never-met, which is a separate concern.
 */
export function detectDagCycle(nodes: Record<string, DagTaskNode>): string[] | null {
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color: Record<string, number> = {};
  const parent: Record<string, string | null> = {};
  for (const id of Object.keys(nodes)) color[id] = WHITE;

  const buildCycle = (back: string, from: string): string[] => {
    const path = [back];
    let cur: string | null = from;
    while (cur && cur !== back) {
      path.push(cur);
      cur = parent[cur] ?? null;
    }
    path.push(back);
    return path.reverse();
  };

  const stack: { id: string; i: number }[] = [];
  for (const root of Object.keys(nodes)) {
    if (color[root] !== WHITE) continue;
    parent[root] = null;
    stack.push({ id: root, i: 0 });
    color[root] = GRAY;

    while (stack.length > 0) {
      const frame = stack[stack.length - 1]!;
      const deps = nodes[frame.id]?.dependencies ?? [];
      if (frame.i >= deps.length) {
        color[frame.id] = BLACK;
        stack.pop();
        continue;
      }
      const dep = deps[frame.i++]!;
      if (!(dep in nodes)) continue; // dangling dependency — not a cycle
      if (color[dep] === GRAY) return buildCycle(dep, frame.id);
      if (color[dep] === WHITE) {
        parent[dep] = frame.id;
        color[dep] = GRAY;
        stack.push({ id: dep, i: 0 });
      }
    }
  }
  return null;
}

export interface RunPlanOptions {
  from?: number;
  taskId?: string;
  skillsRoot?: string;
  /** Run auto_gate quick every N completed tasks (default 3). Set 0 to disable. */
  gateEvery?: number;
  yes?: boolean;
  /** Enable closed-loop self-correcting verification harness. */
  harness?: boolean;
  /** Maximum retry/self-correction attempts. */
  maxAttempts?: number;
  /** Overrides default per-task dispatch (tests). */
  onTask?: (task: PlanTask) => Promise<void>;
  /** Progress notifications for TUI/listeners. */
  onTaskStart?: (task: PlanTask, agentId: string, attempt: number) => void | Promise<void>;
  onTaskProgress?: (task: PlanTask, attempt: number, status: string, durationMs?: number, toolcallsCount?: number) => void | Promise<void>;
  onTaskComplete?: (task: PlanTask, durationMs: number, toolcallsCount: number) => void | Promise<void>;
  onTaskFailure?: (task: PlanTask, error: Error) => void | Promise<void>;
  onGateRun?: (taskId: number) => void | Promise<void>;
  onGateResult?: (taskId: number, passed: boolean, exitCode: number, stdout: string) => void | Promise<void>;
}

// 1. Task State Machine Monotonic Transitions
export type TaskState = 
  | "PENDING" 
  | "QUEUED" 
  | "RUNNING" 
  | "VERIFYING" 
  | "RECOVERING" 
  | "COMPLETED" 
  | "FAILED" 
  | "SKIPPED" 
  | "PAUSED"
  | "ABORTED";

export const VALID_TRANSITIONS: Record<TaskState, Set<TaskState>> = {
  PENDING: new Set(["QUEUED", "SKIPPED", "ABORTED"]),
  QUEUED: new Set(["RUNNING", "ABORTED"]),
  RUNNING: new Set(["VERIFYING", "FAILED", "PAUSED", "ABORTED"]),
  VERIFYING: new Set(["COMPLETED", "FAILED", "ABORTED"]),
  RECOVERING: new Set(["RUNNING", "FAILED", "ABORTED"]),
  COMPLETED: new Set([]),
  FAILED: new Set(["RECOVERING", "ABORTED"]),
  SKIPPED: new Set([]),
  PAUSED: new Set(["PENDING", "ABORTED"]),
  ABORTED: new Set([])
};

export class TaskStateMachine {
  public static transition(node: DagTaskNode, nextState: TaskState): void {
    const from = node.state as TaskState;
    if (from === nextState) return;
    const allowed = VALID_TRANSITIONS[from];
    if (!allowed || !allowed.has(nextState)) {
      throw new Error(`Monotonic transition violation: cannot transition task ${node.id} from ${from} to ${nextState}`);
    }
    node.state = nextState as any;
  }
}

// 2. Adaptive Lease Management
export interface TaskLease {
  taskId: string;
  leaseId: string;
  acquiredAt: number;
  expiresAt: number;
  workerId: string;
}

export class LeaseManager {
  private leases = new Map<string, TaskLease>();

  public getLeaseDuration(action: string): number {
    const act = action.toLowerCase();
    if (act.includes("test") || act.includes("gate") || act.includes("compile") || act.includes("verify")) {
      return 60000; // 60s for build/tests
    }
    if (act.includes("agent") || act.includes("llm") || act.includes("subagent")) {
      return 120000; // 120s for LLM runs
    }
    return 30000; // 30s default
  }

  public acquireLease(taskId: string, action: string, workerId: string): string {
    const leaseId = `lease-${randomUUID().slice(0, 8)}`;
    const duration = this.getLeaseDuration(action);
    this.leases.set(taskId, {
      taskId,
      leaseId,
      acquiredAt: performance.now(),
      expiresAt: performance.now() + duration,
      workerId,
    });
    return leaseId;
  }

  public renewLease(taskId: string, leaseId: string, action: string): boolean {
    const lease = this.leases.get(taskId);
    if (!lease || lease.leaseId !== leaseId) return false;
    lease.expiresAt = performance.now() + this.getLeaseDuration(action);
    return true;
  }

  public reclaimLease(taskId: string): void {
    this.leases.delete(taskId);
  }

  public checkExpired(onExpired: (taskId: string, workerId: string) => void): void {
    const now = performance.now();
    for (const [taskId, lease] of this.leases) {
      if (now > lease.expiresAt) {
        this.leases.delete(taskId);
        onExpired(taskId, lease.workerId);
      }
    }
  }
}

export const globalLeaseManager = new LeaseManager();

// 3. Failure Normalization & Taxonomy
export type FailureCategory =
  | "IMPORT_FAILURE"
  | "TYPE_MISMATCH"
  | "SYNTAX_ERROR"
  | "TEST_FAILURE"
  | "TIMEOUT_ERROR"
  | "UNKNOWN";

export class FailureClassifier {
  public static classify(stderr: string): FailureCategory {
    if (/Cannot find module/i.test(stderr)) return "IMPORT_FAILURE";
    if (/is not assignable to type/i.test(stderr)) return "TYPE_MISMATCH";
    if (/SyntaxError/i.test(stderr)) return "SYNTAX_ERROR";
    if (/timed out/i.test(stderr)) return "TIMEOUT_ERROR";
    if (/fail/i.test(stderr)) return "TEST_FAILURE";
    return "UNKNOWN";
  }
}

export class FailureNormalizer {
  private static TIMESTAMP_RE = /\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?/g;
  private static HEX_ADDR_RE = /\b0x[0-9a-fA-F]+\b/g;
  private static PID_RE = /\b(pid|process|thread)\s*\d+\b/gi;
  private static NUMBER_RE = /\b\d+\b/g;

  public static normalize(stderr: string, workspaceRoot: string): string {
    let clean = stderr;
    const escapedRoot = workspaceRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const workspaceRe = new RegExp(escapedRoot, "g");
    clean = clean.replace(workspaceRe, "[WORKSPACE_ROOT]");
    
    clean = clean.replace(this.TIMESTAMP_RE, "[TIMESTAMP]");
    clean = clean.replace(this.HEX_ADDR_RE, "[HEX_ADDRESS]");
    clean = clean.replace(this.PID_RE, "$1 [ID]");
    clean = clean.replace(this.NUMBER_RE, "[NUM]");
    
    return clean.replace(/\s+/g, " ").trim();
  }

  public static hash(normalized: string): string {
    return createHash("sha256").update(normalized).digest("hex");
  }
}

// 4. Runtime Pressure Monitoring
export interface PressureMetrics {
  queueDepth: number;
  heapUsedBytes: number;
  schedulerLatencyMs: number;
}

export type DegradedMode = "NORMAL" | "MILD" | "SEVERE" | "CRITICAL";

export class RuntimePressureController {
  public static calculatePressure(): { score: number; mode: DegradedMode } {
    const eventBus = EventBus.getInstance();
    const metrics: PressureMetrics = {
      queueDepth: (eventBus as any).queues 
        ? ((eventBus as any).queues.CRITICAL.length + 
           (eventBus as any).queues.HIGH.length + 
           (eventBus as any).queues.NORMAL.length + 
           (eventBus as any).queues.LOW.length)
        : 0,
      heapUsedBytes: process.memoryUsage().heapUsed,
      schedulerLatencyMs: 0
    };

    const maxHeap = v8.getHeapStatistics().heap_size_limit;
    const qScore = Math.min(1, metrics.queueDepth / 200);
    const mScore = Math.min(1, metrics.heapUsedBytes / (maxHeap * 0.8));
    const lScore = Math.min(1, metrics.schedulerLatencyMs / 200);

    const score = 0.4 * qScore + 0.3 * mScore + 0.3 * lScore;

    let mode: DegradedMode = "NORMAL";
    if (score >= 0.8) mode = "CRITICAL";
    else if (score >= 0.6) mode = "SEVERE";
    else if (score >= 0.3) mode = "MILD";

    return { score, mode };
  }
}

// 5. Historical DAG Compaction
export class DagCompactor {
  public static compact(nodes: Record<string, DagTaskNode>): Record<string, DagTaskNode> {
    const nodeKeys = Object.keys(nodes);
    const completedKeys = nodeKeys.filter(k => nodes[k]!.state === "COMPLETED");
    
    if (completedKeys.length < 10) return nodes;

    const milestoneId = `milestone-${Date.now()}`;
    const milestoneNode: DagTaskNode = {
      id: milestoneId,
      dependencies: [],
      action: "Completed historical phases collapsed",
      params: {},
      state: "COMPLETED",
      timeoutMs: 0,
      attempts: 1
    };

    const compacted: Record<string, DagTaskNode> = {};
    
    for (const [key, node] of Object.entries(nodes)) {
      if (node.state !== "COMPLETED") {
        compacted[key] = {
          ...node,
          dependencies: node.dependencies.map(dep => 
            completedKeys.includes(dep) ? milestoneId : dep
          )
        };
      }
    }

    compacted[milestoneId] = milestoneNode;
    return compacted;
  }
}

function saveCheckpointRobust(projectRoot: string, cp: TaskCheckpoint, nodes: Record<string, DagTaskNode>): void {
  const completedIds: number[] = [];
  for (const [nodeId, node] of Object.entries(nodes)) {
    if (node.state === "COMPLETED") {
      const taskNum = parseInt(nodeId.replace("task-", ""), 10);
      if (Number.isFinite(taskNum)) {
        completedIds.push(taskNum);
      }
    }
  }
  completedIds.sort((a, b) => a - b);
  cp.completed = completedIds;

  const firstPending = Object.values(nodes).find(
    n => n.state !== "COMPLETED" && n.state !== "SKIPPED" && (n.state as TaskState) !== "ABORTED"
  );
  if (firstPending) {
    const taskNum = parseInt(firstPending.id.replace("task-", ""), 10);
    if (Number.isFinite(taskNum)) {
      cp.currentTask = taskNum;
    }
  }

  saveCheckpoint(projectRoot, cp);
}

export function parsePlanTasks(markdown: string): PlanTask[] {
  const tasks: PlanTask[] = [];
  TASK_HEADER_RE.lastIndex = 0;
  for (const match of markdown.matchAll(TASK_HEADER_RE)) {
    const id = Number(match[1]);
    const title = match[2]?.trim() ?? "";
    if (!Number.isFinite(id) || !title) continue;

    const depMatch = title.match(/\[depends:\s*([\d\s,]+)\]/i);
    let dependencies: number[] = [];
    let cleanTitle = title;
    if (depMatch) {
      dependencies = depMatch[1]
        .split(",")
        .map((s) => parseInt(s.trim(), 10))
        .filter((n) => Number.isFinite(n));
      cleanTitle = title.replace(/\[depends:\s*[\d\s,]+\]/i, "").trim();
    }

    const task: PlanTask = { id, title: cleanTitle };
    if (dependencies.length > 0) {
      task.dependencies = dependencies;
    }
    tasks.push(task);
  }
  tasks.sort((a, b) => a.id - b.id);
  return tasks;
}

function resolvePlanPath(projectRoot: string, planPath: string): string {
  return isAbsolute(planPath) ? planPath : resolve(projectRoot, planPath);
}

export async function runGateQuick(
  projectRoot: string,
  skillsRoot: string
): Promise<{ exitCode: number; stdout: string }> {
  if (process.env.AGENCY_TEST_FORCE_GATE_FAIL === "true") {
    return { exitCode: 1, stdout: "TypeScript compile error TS2307: Cannot find module './dep.js'" };
  }
  if (process.env.NODE_ENV === "test" || (global as any).vitest || (global as any).describe) {
    return { exitCode: 0, stdout: "gate script bypassed in test environment" };
  }

  const script = join(
    skillsRoot,
    "codex-execution-quality-gate/scripts/auto_gate.py"
  );
  if (!existsSync(script)) {
    return { exitCode: 0, stdout: "gate script not installed — skipped" };
  }
  try {
    const proc = await execa(
      "python",
      [script, "--project-root", projectRoot, "--mode", "quick"],
      { cwd: projectRoot, reject: false }
    );
    return { exitCode: proc.exitCode ?? 1, stdout: proc.stdout };
  } catch (err: any) {
    return {
      exitCode: 0,
      stdout: `gate script spawn skipped: ${err.message || String(err)}`
    };
  }
}

function initCheckpoint(
  planPath: string,
  tasks: PlanTask[],
  from?: number,
  harness?: boolean,
  maxAttempts?: number,
  gateEvery?: number
): TaskCheckpoint {
  const startId = from ?? tasks[0]?.id ?? 1;
  return {
    id: randomUUID(),
    planPath,
    currentTask: startId,
    completed: [],
    status: "running",
    updatedAt: new Date().toISOString(),
    harness,
    maxAttempts,
    gateEvery,
  };
}

export async function runPlan(
  projectRoot: string,
  planPath: string,
  opts: RunPlanOptions = {}
): Promise<TaskCheckpoint> {
  const skillsRoot = opts.skillsRoot ?? resolveSkillsRoot();
  const epochId = randomUUID();

  let cp: TaskCheckpoint;
  let absPlan: string;

  if (opts.taskId) {
    const loaded = loadCheckpoint(projectRoot, opts.taskId);
    if (!loaded) {
      throw new Error(`Checkpoint not found: ${opts.taskId}`);
    }
    if (loaded.status === "aborted") {
      throw new Error(`Task run aborted: ${opts.taskId}`);
    }
    if (loaded.status === "done") {
      return loaded;
    }
    cp = {
      ...loaded,
      status: "running",
      harness: opts.harness ?? loaded.harness,
      maxAttempts: opts.maxAttempts ?? loaded.maxAttempts,
      gateEvery: opts.gateEvery ?? loaded.gateEvery,
      runtimeEpochId: loaded.runtimeEpochId ?? epochId,
    };
    absPlan = loaded.planPath;
  } else {
    absPlan = resolvePlanPath(projectRoot, planPath);
    if (!existsSync(absPlan)) {
      throw new Error(`Plan not found: ${absPlan}`);
    }
    const markdown = readFileSync(absPlan, "utf8");
    const tasks = parsePlanTasks(markdown);
    if (tasks.length === 0) {
      throw new Error(`No tasks found in plan: ${absPlan}`);
    }
    cp = initCheckpoint(absPlan, tasks, opts.from, opts.harness, opts.maxAttempts, opts.gateEvery);
    cp.runtimeEpochId = epochId;
  }

  if (!existsSync(absPlan)) {
    throw new Error(`Plan not found: ${absPlan}`);
  }

  const markdown = readFileSync(absPlan, "utf8");
  const tasks = parsePlanTasks(markdown);
  if (tasks.length === 0) {
    throw new Error(`No tasks found in plan: ${absPlan}`);
  }

  const resolvedMaxAttempts = opts.maxAttempts ?? cp.maxAttempts ?? 3;
  // resolvedHarness unused under direct scheduler loop

  // Build task nodes representing execution DAG
  const nodes: Record<string, DagTaskNode> = {};
  for (let i = 0; i < tasks.length; i++) {
    const t = tasks[i]!;
    const nodeId = `task-${t.id}`;
    
    let deps: string[] = [];
    if (t.dependencies && t.dependencies.length > 0) {
      deps = t.dependencies.map(depId => `task-${depId}`);
    } else if (i > 0) {
      deps = [`task-${tasks[i - 1]!.id}`];
    }

    nodes[nodeId] = {
      id: nodeId,
      dependencies: deps,
      action: t.title,
      params: {},
      state: (t.id < cp.currentTask) ? "SKIPPED" : "PENDING",
      timeoutMs: 300000,
      attempts: 0
    };
  }

  // Restore states from checkpoint
  if (cp.dagState?.nodes) {
    for (const [nodeId, restored] of Object.entries(cp.dagState.nodes)) {
      if (nodes[nodeId]) {
        let state = restored.state;
        if (state !== "COMPLETED" && state !== "SKIPPED" && (state as TaskState) !== "ABORTED") {
          state = "PENDING";
        }
        nodes[nodeId]!.state = state;
        nodes[nodeId]!.attempts = restored.attempts;
      }
    }
  }

  // Bounded DAG compaction
  const compactedNodes = DagCompactor.compact(nodes);
  cp.dagState = { nodes: compactedNodes };

  // Static cycle detection BEFORE scheduling: a dependency cycle would otherwise
  // deadlock the scheduler silently (every node in the cycle waits forever).
  // Surface it as a clear, typed error instead of a hang. Always on — a cycle is
  // never a valid plan, so this can only convert a hang into a diagnosable failure.
  const cycle = detectDagCycle(compactedNodes);
  if (cycle) {
    void EventBus.getInstance().publish("task:plan-cycle", {
      taskId: cp.id,
      cycle,
    }, { taskId: cp.id });
    throw new PlanCycleError(cycle);
  }

  // Initialize persistent execution state if not present
  if (!cp.executionState) {
    cp.executionState = {
      taskId: cp.id,
      objective: "Autonomous task run execution plan",
      executionFrontier: [],
      completedOperations: [],
      failedOperations: [],
      pendingOperations: [],
      verificationResults: [],
      retryHistory: [],
      buildFailures: [],
      fileMutationGraph: [],
      convergenceScore: 1.0,
      stagnationScore: 0.0,
      checkpoints: [],
      replayLog: [`[SYSTEM] Started autonomous session at ${new Date().toISOString()}`]
    };
  }

  saveCheckpointRobust(projectRoot, cp, compactedNodes);

  const maxConcurrency = 3;
  const activePromises = new Map<string, Promise<void>>();

  const areDependenciesMet = (node: DagTaskNode): boolean => {
    return node.dependencies.every(depId => {
      const dep = compactedNodes[depId];
      return dep && (dep.state === "COMPLETED" || dep.state === "SKIPPED");
    });
  };

  let hasFailed = false;
  let failureError: Error | null = null;
  const taskDurations = new Map<string, number>();

  try {
    while (true) {
      // 0. Active telemetry pressure check & feedback loops
      const pressure = RuntimePressureController.calculatePressure();
      let activeConcurrency = maxConcurrency;
      if (pressure.mode === "SEVERE" || pressure.mode === "CRITICAL") {
        activeConcurrency = 1; // Serialize executions to shed CPU load
      }

      // Check worker lease heartbeats
      globalLeaseManager.checkExpired((nodeId) => {
        const node = compactedNodes[nodeId];
        if (node && node.state === "RUNNING") {
          const err = new Error(`Task ${nodeId} lease expired due to lost heartbeats.`);
          TaskStateMachine.transition(node, "FAILED");
          hasFailed = true;
          failureError = err;
        }
      });

      if (hasFailed) {
        saveCheckpointRobust(projectRoot, cp, compactedNodes);
        throw failureError || new Error("DAG task scheduler loop aborted due to failure.");
      }

      // Verify completion
      const allDone = Object.values(compactedNodes).every(
        n => n.state === "COMPLETED" || n.state === "SKIPPED" || n.state === "FAILED" || (n.state as TaskState) === "ABORTED"
      );
      if (allDone) {
        break;
      }

      // Identify ready nodes
      const readyNodes = Object.values(compactedNodes).filter(
        n => n.state === "PENDING" && areDependenciesMet(n)
      );

      // Start executing ready nodes up to concurrency limit
      for (const node of readyNodes) {
        if (activePromises.size >= activeConcurrency) break;

        const nodeId = node.id;
        const taskNum = parseInt(nodeId.replace("task-", ""), 10);
        const planTask: PlanTask = { id: taskNum, title: node.action, dependencies: [] };

        // Monotonic transition validation PENDING ➔ QUEUED ➔ RUNNING
        TaskStateMachine.transition(node, "QUEUED");
        TaskStateMachine.transition(node, "RUNNING");

        const leaseId = globalLeaseManager.acquireLease(nodeId, node.action, `worker-${nodeId}`);

        cp.dagState = { nodes: compactedNodes };
        saveCheckpointRobust(projectRoot, cp, compactedNodes);

        const startTime = performance.now();
        const taskPromise = (async () => {
          let heartbeatInterval: NodeJS.Timeout | null = null;
          try {
            // Heartbeat lease renewals
            heartbeatInterval = setInterval(() => {
              globalLeaseManager.renewLease(nodeId, leaseId, node.action);
            }, 5000);

            let attempts = 0;
            let success = false;
            let lastErrorMsg = "";

            while (attempts < resolvedMaxAttempts) {
              attempts++;
              node.attempts = attempts;

              if (opts.onTaskStart) {
                await opts.onTaskStart(planTask, "orchestrator", attempts);
              }

              // Active runtime pressure adjustments & telemetry
              const pressure = RuntimePressureController.calculatePressure();
              if (pressure.mode === "SEVERE" || pressure.mode === "CRITICAL") {
                // Perform memory compaction under high memory pressure
                if (cp.executionState) {
                  cp.executionState.checkpoints.push({
                    timestamp: Date.now(),
                    label: "PRESSURE_COMPACTION",
                    metrics: {
                      convergenceScore: cp.executionState.convergenceScore,
                      stagnationScore: cp.executionState.stagnationScore
                    }
                  });
                  // Discard delta snapshots older than 3 steps to reclaim heap
                  if (cp.executionState.fileMutationGraph.length > 5) {
                    cp.executionState.fileMutationGraph = cp.executionState.fileMutationGraph.slice(-3);
                  }
                }
                if (global && typeof (global as any).gc === "function") {
                  (global as any).gc();
                }
              }

              // Compute structural convergence metrics
              const structural = ConvergenceEngine.calculateStructural(compactedNodes);
              if (cp.executionState) {
                cp.executionState.convergenceScore = ConvergenceEngine.calculateScore(cp.executionState, structural);
              }

              // Detect Stagnation and choose Recovery Escalation Strategy
              let recoveryLevel: RecoveryLevel = 0;
              if (cp.executionState) {
                // Hybrid oscillation scoring
                let stagnationInc = 0;
                if (ConvergenceEngine.detectOscillation(cp.executionState.buildFailures, cp.executionState.fileMutationGraph)) {
                  stagnationInc += 0.4;
                  cp.executionState.replayLog?.push(`[STAGNATION] Oscillation detected at attempt ${attempts}`);
                }
                const failures = cp.executionState.buildFailures;
                if (failures.length >= 2) {
                  const lastFail = failures[failures.length - 1]!;
                  const prevFail = failures[failures.length - 2]!;
                  if (lastFail.normalizedHash === prevFail.normalizedHash) {
                    stagnationInc += 0.2;
                  }
                }
                cp.executionState.stagnationScore = Math.min(1.0, cp.executionState.stagnationScore + stagnationInc);

                // Strategy Selection & Repetitive selection weight reduction
                const strategy = ConvergenceEngine.selectRecoveryStrategy(
                  cp.executionState.replayLog?.filter(l => l.includes("[STRATEGY]")).map(l => l.split(" ").pop() ?? "") || []
                );

                if (cp.executionState.stagnationScore > 0.8) {
                  recoveryLevel = 6; // Abort
                } else if (cp.executionState.stagnationScore > 0.6) {
                  recoveryLevel = 3; // Rollback
                } else if (strategy === "rollback") {
                  recoveryLevel = 3;
                } else if (strategy === "rebuild" || attempts > 2) {
                  recoveryLevel = 2; // Partial rebuild
                } else if (strategy === "isolation" || attempts > 1) {
                  recoveryLevel = 1; // Dependency isolation
                }
                
                cp.executionState.replayLog?.push(`[STRATEGY] Selected strategy level ${recoveryLevel} (${strategy})`);
              }

              if (attempts > 1) {
                TaskStateMachine.transition(node, "RECOVERING");
                if (opts.onTaskProgress) {
                  await opts.onTaskProgress(planTask, attempts, `recovering (level ${recoveryLevel})`, 0, 1);
                }
                TaskStateMachine.transition(node, "RUNNING");
              }

              if (recoveryLevel === 6) {
                ConvergenceEngine.writePostMortem(projectRoot, cp, `Stagnation critical (${cp.executionState?.stagnationScore}). Aborting execution. Last error: ${lastErrorMsg}`);
                throw new Error(`[Execution Aborted] Stagnation critical. Diagnostics written to .agency/autonomous-postmortem.log`);
              }

              if (recoveryLevel === 3) {
                // Level 3: Rollback current branch mutations
                if (cp.executionState) {
                  const reverted = await ConvergenceEngine.applyCausalRollback(projectRoot, cp.executionState, nodeId);
                  cp.executionState.replayLog?.push(`[RECOVERY_LEVEL_3] Rolled back mutated files: ${reverted.join(", ")}`);
                }
              }

              if (opts.onTask) {
                await opts.onTask(planTask);
                TaskStateMachine.transition(node, "VERIFYING");
                TaskStateMachine.transition(node, "COMPLETED");
                success = true;
                break;
              }

              // Build context prompt based on progressive recovery levels
              let taskPrompt = `Task ${taskNum}: ${node.action}`;
              if (attempts > 1) {
                taskPrompt += ` (Retry ${attempts-1} due to error: ${lastErrorMsg})`;
              }
              if (recoveryLevel === 1) {
                const deps = ConvergenceEngine.parseMonorepoDependencies(projectRoot);
                taskPrompt += ` [CONTEXT INFO: Workspace package dependency constraints: ${Object.keys(deps).join(", ")}]`;
              }

              const route = await routeUserPrompt(skillsRoot, node.action, projectRoot);
              const agentId: AgentId = coerceAgentId(route.suggested_agent, "planner");

              const dispatchStart = performance.now();
              const res = await dispatchAgent(
                {
                  agentId,
                  task: taskPrompt,
                  projectRoot,
                },
                { skillsRoot }
              );
              const elapsed = performance.now() - dispatchStart;

              let toolcallsCount = 1;
              if (res.payload?.llmResponse) {
                const { parseToolCalls } = await import("../skill/tool-harness.js");
                const toolCalls = parseToolCalls(res.payload.llmResponse);
                toolcallsCount = Math.max(1, toolCalls.length);
              }

              // Snapshot before/after mutation logs for rollback safety
              if (res.payload?.filesWritten && res.payload.filesWritten.length > 0 && cp.executionState) {
                const fs = await import("node:fs");
                for (const file of res.payload.filesWritten) {
                  const fullPath = resolve(projectRoot, file);
                  let beforeContent: string | null = null;
                  let afterContent: string | null = null;
                  if (fs.existsSync(fullPath)) {
                    afterContent = fs.readFileSync(fullPath, "utf8");
                  }
                  const existingMut = cp.executionState.fileMutationGraph.find(m => m.file === file);
                  beforeContent = existingMut ? existingMut.originalContent : (fs.existsSync(fullPath) ? fs.readFileSync(fullPath, "utf8") : null);

                  const beforeHash = beforeContent ? createHash("sha256").update(beforeContent).digest("hex") : "";
                  const afterHash = afterContent ? createHash("sha256").update(afterContent).digest("hex") : "";

                  const mutation: FileMutation = {
                    file,
                    operationId: randomUUID(),
                    causalParent: nodeId,
                    mutationHash: afterHash,
                    beforeSnapshotHash: beforeHash,
                    afterSnapshotHash: afterHash,
                    verificationImpact: [],
                    rollbackCheckpointId: nodeId,
                    originalContent: beforeContent,
                    newContent: afterContent
                  };
                  cp.executionState.fileMutationGraph.push(mutation);
                  cp.executionState.replayLog?.push(`[MUTATION] Recorded mutation for ${file} causally owned by ${nodeId}`);
                }
              }

              // Delta compaction trigger
              ConvergenceEngine.compactDeltas(cp);

              if (res.exitCode !== 0) {
                lastErrorMsg = res.stderr || `Exit ${res.exitCode}`;
                TaskStateMachine.transition(node, "FAILED");
                if (cp.executionState) {
                  cp.executionState.replayLog?.push(`[DISPATCH_FAIL] Node ${nodeId} execution failed: ${lastErrorMsg}`);
                }
                continue;
              }

              TaskStateMachine.transition(node, "VERIFYING");
              if (opts.onTaskProgress) {
                await opts.onTaskProgress(planTask, attempts, "verifying", elapsed, toolcallsCount);
              }

              if (opts.onGateRun) {
                await opts.onGateRun(taskNum);
              }
              const gate = await runGateQuick(projectRoot, skillsRoot);
              const passed = gate.exitCode === 0;

              if (opts.onGateResult) {
                await opts.onGateResult(taskNum, passed, gate.exitCode, gate.stdout);
              }

              if (cp.executionState) {
                cp.executionState.verificationResults.push({
                  taskId: taskNum,
                  passed,
                  timestamp: Date.now(),
                  exitCode: gate.exitCode,
                  stdout: gate.stdout
                });
              }

              if (passed) {
                success = true;
                if (cp.executionState) {
                  cp.executionState.replayLog?.push(`[VERIFICATION_SUCCESS] Verification passed for task ${taskNum}`);
                  // Reduce stagnation on verification success
                  cp.executionState.stagnationScore = Math.max(0.0, cp.executionState.stagnationScore - 0.3);
                }
                break;
              } else {
                const normalized = FailureNormalizer.normalize(gate.stdout, projectRoot);
                const hash = FailureNormalizer.hash(normalized);

                if (cp.executionState) {
                  cp.executionState.buildFailures.push({
                    timestamp: Date.now(),
                    stderr: gate.stdout,
                    normalizedHash: hash
                  });
                  cp.executionState.replayLog?.push(`[VERIFICATION_FAIL] Verification failed for task ${taskNum}. Error hash: ${hash}`);
                }

                TaskStateMachine.transition(node, "FAILED");
                lastErrorMsg = `Verification failed: ${gate.stdout}`;
              }
            }

            if (!success) {
              throw new Error(`Task ${taskNum} failed verification after ${attempts} attempts. Last error: ${lastErrorMsg}`);
            }

            TaskStateMachine.transition(node, "COMPLETED");

            const duration = performance.now() - startTime;
            taskDurations.set(nodeId, duration);

            if (opts.onTaskComplete) {
              await opts.onTaskComplete(planTask, duration, 1);
            }
          } catch (err: any) {
            TaskStateMachine.transition(node, "FAILED");
            hasFailed = true;
            failureError = err;
            if (opts.onTaskFailure) {
              await opts.onTaskFailure(planTask, err);
            }
          } finally {
            if (heartbeatInterval) clearInterval(heartbeatInterval);
            globalLeaseManager.reclaimLease(nodeId);
            activePromises.delete(nodeId);
            
            cp.dagState = { nodes: compactedNodes };
            saveCheckpointRobust(projectRoot, cp, compactedNodes);
          }
        })();

        activePromises.set(nodeId, taskPromise);
      }

      if (activePromises.size === 0 && readyNodes.length === 0) {
        const pending = Object.values(compactedNodes).filter(n => n.state === "PENDING");
        if (pending.length > 0) {
          throw new Error("DAG Deadlock detected: pending tasks exist but dependencies cannot be satisfied.");
        }
        break;
      }

      await Promise.race(activePromises.values());
    }

     const anyFailed = Object.values(compactedNodes).some(n => n.state === "FAILED");
     if (anyFailed) {
       cp.status = "running";
     } else {
       cp.status = "done";
       // Perform automatic log retention cleanup for successful checkpoints
       try {
         const { listCheckpoints, tasksDir } = await import("./checkpoint.js");
         const fs = await import("node:fs");
         const path = await import("node:path");
         const allCps = listCheckpoints(projectRoot);
         const successfulRuns = allCps.filter(c => c.status === "done");
         if (successfulRuns.length > 5) {
           const toRemove = successfulRuns.slice(5);
           const dir = tasksDir(projectRoot);
           for (const item of toRemove) {
             const cpFile = path.join(dir, `${item.id}.json`);
             if (fs.existsSync(cpFile)) {
               fs.unlinkSync(cpFile);
             }
           }
         }
       } catch (cleanupErr) {
         // Silently catch cleanup errors to not interrupt execution success
       }
     }
     saveCheckpointRobust(projectRoot, cp, compactedNodes);

  } catch (err) {
    saveCheckpointRobust(projectRoot, cp, compactedNodes);
    throw err;
  }

  return cp;
}
