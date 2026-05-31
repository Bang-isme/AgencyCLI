/**
 * Runtime bootstrap: the startup sequence that turns a cold process into a
 * recoverable, observable runtime. Wires the durable event journal into the
 * EventBus and discovers interrupted tasks so the host can resume them.
 *
 * Spec (docs/PRODUCTION_AUDIT.md §4 P0): "On startup — load event logs, rebuild
 * state, resume unfinished work." This closes the CRITICAL gaps where the
 * EventJournal was never instantiated and checkpoints were never read on boot.
 */
import { join } from "node:path";
import { mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { EventBus } from "../events/event-bus.js";
import { EventJournal } from "../events/event-journal.js";
import { listCheckpoints, type TaskCheckpoint } from "../task/checkpoint.js";
import { getRuntimeFlags } from "./flags.js";
import { runMemoryMaintenance, getDb, setSecretScanEnabled, type GcReport, type StorageTelemetry } from "@agency/memory";
import { recoverPendingMutations, type MutationRecovery } from "@agency/workspace";
import { setModelCatalogEnabled, getModelSpec } from "@agency/providers";
import { setModelCostResolver } from "@agency/governance";

export interface RecoverableTask {
  id: string;
  planPath: string;
  currentTask: number;
  completed: number[];
  status: TaskCheckpoint["status"];
  updatedAt: string;
}

export interface BootstrapResult {
  profile: string;
  /** True if the durable event journal was attached to the EventBus. */
  journalAttached: boolean;
  /** Tasks left in a resumable state by a prior (possibly crashed) run. */
  recoverable: RecoverableTask[];
  /** Whether the runtime is configured to auto-resume the recoverable tasks. */
  autoRecover: boolean;
  /** Result of the startup memory GC pass, or null when disabled/unavailable. */
  memoryGc: GcReport | null;
  /** Half-applied multi-file commits rolled back on startup (atomic-rollback recovery). */
  mutationRecovery: MutationRecovery[];
}

/**
 * Reads memory-store size telemetry for observability (`agency status`).
 * Returns null when the store can't be opened — never throws.
 */
export function getMemoryTelemetry(projectRoot: string): StorageTelemetry | null {
  try {
    return getDb(projectRoot).getTelemetry();
  } catch {
    return null;
  }
}

/** A checkpoint is resumable if its prior run did not reach a terminal state. */
function isResumable(status: TaskCheckpoint["status"]): boolean {
  return status === "running" || status === "paused";
}

/**
 * Scans `.agency/tasks` for checkpoints left in a non-terminal state by a
 * previous run. Pure read — never mutates or resumes anything.
 */
export function discoverRecoverableTasks(projectRoot: string): RecoverableTask[] {
  return listCheckpoints(projectRoot)
    .filter((cp) => isResumable(cp.status))
    .map((cp) => ({
      id: cp.id,
      planPath: cp.planPath,
      currentTask: cp.currentTask,
      completed: cp.completed ?? [],
      status: cp.status,
      updatedAt: cp.updatedAt,
    }));
}

// --- Auto-resume (maturity tier 2: "recoverable") -------------------------
//
// The crash-loop counter lives in its own dir (NOT .agency/tasks) so
// listCheckpoints — which scans .agency/tasks/*.json — never mis-parses it.

function resumeStatePath(projectRoot: string, taskId: string): string {
  return join(projectRoot, ".agency", "resume", `${taskId}.json`);
}

function readResumeAttempts(projectRoot: string, taskId: string): number {
  try {
    const n = (JSON.parse(readFileSync(resumeStatePath(projectRoot, taskId), "utf8")) as { attempts?: number }).attempts;
    return typeof n === "number" && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}

function writeResumeAttempts(projectRoot: string, taskId: string, attempts: number): void {
  try {
    mkdirSync(join(projectRoot, ".agency", "resume"), { recursive: true });
    writeFileSync(
      resumeStatePath(projectRoot, taskId),
      JSON.stringify({ attempts, updatedAt: new Date().toISOString() }),
      "utf8"
    );
  } catch {
    /* best-effort — losing the counter at worst allows one extra retry */
  }
}

function clearResumeAttempts(projectRoot: string, taskId: string): void {
  try {
    rmSync(resumeStatePath(projectRoot, taskId), { force: true });
  } catch {
    /* best-effort */
  }
}

export interface AutoResumeOutcome {
  taskId: string;
  /** True if runPlan was actually invoked for this task. */
  resumed: boolean;
  /** Terminal status reported by runPlan, when it ran. */
  status?: TaskCheckpoint["status"];
  /** True when the crash-loop ceiling was hit and the task was escalated, not run. */
  abandoned: boolean;
  /** Resume attempts recorded (including this one). */
  attempts: number;
  error?: string;
}

export interface AutoResumeOptions {
  /** Override the crash-loop ceiling (defaults to flags.maxCrashLoops). */
  maxCrashLoops?: number;
  /** Inject runPlan (tests). Defaults to the real task runner (lazy-imported). */
  runPlan?: (
    projectRoot: string,
    planPath: string,
    opts: { taskId: string }
  ) => Promise<TaskCheckpoint>;
}

/**
 * Completes maturity tier 2 ("recoverable"): actually re-runs tasks a prior
 * (crashed) run left mid-flight — behind the `autoRecover` flag and a per-task
 * crash-loop counter.
 *
 * Only `running` checkpoints (a run that died mid-execution) are auto-resumed;
 * `paused` tasks are intentional and left for explicit `agency task resume`.
 * Each task's attempt count is persisted to `.agency/resume/<id>.json` BEFORE
 * runPlan is invoked, so a crash *during* resume is still counted — after
 * `maxCrashLoops` failures the task is abandoned (escalated via
 * `task:resume-abandoned`) instead of looping forever. A run that reaches
 * `done` clears the counter.
 *
 * Best-effort and flag-gated: a no-op (returns `[]`) when `autoRecover` is off,
 * so legacy behaviour is unchanged. Never throws — one bad task can't abort the
 * whole resume sweep (or startup).
 */
export async function autoResumeRecoverableTasks(
  projectRoot: string,
  opts: AutoResumeOptions = {},
  bus: EventBus = EventBus.getInstance()
): Promise<AutoResumeOutcome[]> {
  const flags = getRuntimeFlags();
  if (!flags.autoRecover) return [];

  const crashed = discoverRecoverableTasks(projectRoot).filter((t) => t.status === "running");
  if (crashed.length === 0) return [];

  const maxLoops = Math.max(1, opts.maxCrashLoops ?? flags.maxCrashLoops);
  const run =
    opts.runPlan ??
    (async (root: string, planPath: string, o: { taskId: string }) => {
      const { runPlan } = await import("../task/runner.js");
      return runPlan(root, planPath, o);
    });

  const outcomes: AutoResumeOutcome[] = [];

  for (const task of crashed) {
    const prior = readResumeAttempts(projectRoot, task.id);

    // Crash-loop guard: a task that keeps dying on resume must not loop forever.
    // Don't clear the counter — explicit `agency task resume` bypasses this path.
    if (prior >= maxLoops) {
      await bus.publish(
        "task:resume-abandoned",
        { taskId: task.id, attempts: prior, maxCrashLoops: maxLoops },
        { taskId: task.id }
      );
      outcomes.push({ taskId: task.id, resumed: false, abandoned: true, attempts: prior });
      continue;
    }

    const attempt = prior + 1;
    // Count up-front so a crash *during* runPlan is still counted next boot.
    writeResumeAttempts(projectRoot, task.id, attempt);
    await bus.publish("task:resume-start", { taskId: task.id, attempt }, { taskId: task.id });

    const startTime = Date.now();
    try {
      const result = await run(projectRoot, task.planPath, { taskId: task.id });
      if (result.status === "done") clearResumeAttempts(projectRoot, task.id);
      await bus.publish(
        "task:resume-finished",
        { taskId: task.id, status: result.status, attempt },
        { taskId: task.id, durationMs: Date.now() - startTime }
      );
      outcomes.push({
        taskId: task.id,
        resumed: true,
        status: result.status,
        abandoned: false,
        attempts: attempt,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await bus.publish(
        "task:resume-error",
        { taskId: task.id, attempt, error: message },
        { taskId: task.id, durationMs: Date.now() - startTime }
      );
      outcomes.push({ taskId: task.id, resumed: true, abandoned: false, attempts: attempt, error: message });
    }
  }

  return outcomes;
}

/**
 * Creates (if needed) and attaches the durable SQLite event journal to the
 * EventBus singleton, warm-loading the in-memory tail + sequence counter.
 * Flag-gated by `persistEvents`; returns the journal, or null when disabled or
 * unavailable. Never throws — durability must not block startup.
 */
export function initEventPersistence(
  projectRoot: string,
  bus: EventBus = EventBus.getInstance()
): EventJournal | null {
  if (!getRuntimeFlags().persistEvents) return null;
  try {
    const journal = new EventJournal(projectRoot);
    bus.attachDurableJournal(journal);
    return journal;
  } catch {
    // Durability is best-effort; a broken journal must not prevent the runtime
    // from starting in degraded (memory-only) mode.
    return null;
  }
}

/**
 * One-call startup hook for any entrypoint (chat, task, tui). Idempotent enough
 * to call once per process. Returns a structured summary the host can surface.
 */
export function bootstrapRuntime(
  projectRoot: string,
  bus: EventBus = EventBus.getInstance()
): BootstrapResult {
  const flags = getRuntimeFlags();
  const journal = initEventPersistence(projectRoot, bus);
  const recoverable = discoverRecoverableTasks(projectRoot);

  // Apply the secret-on-persist policy to the memory backend (it can't read the
  // core flags directly without a dependency cycle).
  setSecretScanEnabled(flags.secretScan);

  // Model catalog: accurate per-model limits/cost/capabilities for any BYOK
  // model. Enable spec enrichment, and wire the cost governor's pricing to the
  // catalog (replaces its tiny built-in rate table when on). Same setter pattern
  // — providers/governance can't import core flags without a cycle.
  setModelCatalogEnabled(flags.modelCatalog);
  setModelCostResolver(
    flags.modelCatalog
      ? (modelId: string) => {
          try {
            return getModelSpec(modelId).cost ?? null;
          } catch {
            return null;
          }
        }
      : null
  );

  // Bound memory growth on startup so a long-lived install doesn't accumulate
  // unbounded episodes/vectors. Best-effort; returns null when disabled.
  const memoryGc = flags.memoryGc
    ? runMemoryMaintenance(projectRoot, {
        maxEpisodes: flags.memoryMaxEpisodes,
        maxVectors: flags.memoryMaxVectors,
      })
    : null;

  // Roll back any multi-file commit a prior run died in the middle of, so the
  // tree is never left half-written. Best-effort; gated on atomicRollback.
  let mutationRecovery: MutationRecovery[] = [];
  if (flags.atomicRollback) {
    try {
      mutationRecovery = recoverPendingMutations(projectRoot);
    } catch {
      mutationRecovery = [];
    }
    for (const r of mutationRecovery) {
      void bus.publish("recovery:mutation-rolled-back", { txId: r.txId, files: r.rolledBack }, { taskId: r.txId });
    }
  }

  void bus.publish("runtime:bootstrap", {
    profile: flags.profile,
    journalAttached: journal !== null,
    recoverableCount: recoverable.length,
    autoRecover: flags.autoRecover,
    memoryGc,
    mutationRecoveredCount: mutationRecovery.length,
  });

  return {
    profile: flags.profile,
    journalAttached: journal !== null,
    recoverable,
    autoRecover: flags.autoRecover,
    memoryGc,
    mutationRecovery,
  };
}
