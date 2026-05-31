import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  openSync,
  fsyncSync,
  closeSync,
  renameSync
} from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { DagTaskNode } from "@agency/contracts";
import { getRuntimeFlags } from "../runtime/flags.js";
import { EventBus } from "../events/event-bus.js";

export interface ExecutionNode {
  id: string;
  action: string;
  state: string;
  attempts: number;
  durationMs?: number;
}

export interface Operation {
  id: string;
  type: string;
  status: string;
  timestamp: number;
  details?: string;
}

export interface VerificationResult {
  taskId: number;
  passed: boolean;
  timestamp: number;
  exitCode: number;
  stdout: string;
}

export interface RetryEntry {
  nodeId: string;
  attempt: number;
  timestamp: number;
  error?: string;
}

export interface BuildFailure {
  timestamp: number;
  stderr: string;
  normalizedHash: string;
}

export interface FileMutation {
  file: string;
  operationId: string;
  causalParent?: string;
  mutationHash: string;
  beforeSnapshotHash: string;
  afterSnapshotHash: string;
  verificationImpact: string[];
  rollbackCheckpointId?: string;
  originalContent: string | null;
  newContent: string | null;
}

export interface RuntimeCheckpoint {
  timestamp: number;
  label: string;
  metrics: {
    convergenceScore: number;
    stagnationScore: number;
  };
}

export interface RuntimeExecutionState {
  taskId: string;
  objective: string;
  executionFrontier: ExecutionNode[];
  completedOperations: Operation[];
  failedOperations: Operation[];
  pendingOperations: Operation[];
  verificationResults: VerificationResult[];
  retryHistory: RetryEntry[];
  buildFailures: BuildFailure[];
  fileMutationGraph: FileMutation[];
  convergenceScore: number;
  stagnationScore: number;
  recoveryPhase?: string;
  checkpoints: RuntimeCheckpoint[];
  replayLog?: string[];
}

export interface TaskCheckpoint {
  version?: number; // v2 = 2, undefined is v1
  /** SHA-256 over the rest of the record; validated on load to catch corruption/tampering. */
  checksum?: string;
  id: string;
  planPath: string;
  currentTask: number;
  completed: number[];
  status: "running" | "paused" | "done" | "aborted";
  updatedAt: string;
  harness?: boolean;
  maxAttempts?: number;
  gateEvery?: number;
  runtimeEpochId?: string;
  dagState?: {
    nodes: Record<string, DagTaskNode>;
  };
  contextState?: any;
  executionState?: RuntimeExecutionState;
}

export class CheckpointMigrator {
  public static migrate(data: any): TaskCheckpoint {
    const version = data.version || 1;
    if (version >= 2) {
      return data as TaskCheckpoint;
    }

    // Migrate V1 (flat task checklists) ➔ V2 (DAG representation)
    const nodes: Record<string, DagTaskNode> = {};
    const completedList = data.completed || [];
    
    completedList.forEach((taskIdNum: number, index: number) => {
      const nodeId = `task-${taskIdNum}`;
      const depNodeId = index > 0 ? `task-${completedList[index - 1]}` : undefined;
      nodes[nodeId] = {
        id: nodeId,
        dependencies: depNodeId ? [depNodeId] : [],
        action: `Task ${taskIdNum}`,
        params: {},
        state: "COMPLETED",
        timeoutMs: 300000,
        attempts: 1
      };
    });

    return {
      ...data,
      version: 2,
      dagState: { nodes }
    };
  }
}

export function tasksDir(projectRoot: string): string {
  return join(projectRoot, ".agency", "tasks");
}

function checkpointPath(projectRoot: string, id: string): string {
  return join(tasksDir(projectRoot), `${id}.json`);
}

/**
 * SHA-256 over the record with any existing `checksum` field removed, so the
 * digest is computed over exactly the same bytes on save and on load. Compact
 * (no-indent) stringify keeps it independent of the on-disk pretty-printing.
 */
function computeCheckpointChecksum(obj: object): string {
  const { checksum: _omit, ...rest } = obj as Record<string, unknown>;
  return createHash("sha256").update(JSON.stringify(rest)).digest("hex");
}

export function saveCheckpoint(projectRoot: string, cp: TaskCheckpoint): void {
  const dir = tasksDir(projectRoot);
  mkdirSync(dir, { recursive: true });

  // Drop any stale checksum coming in via the spread before recomputing.
  const { checksum: _stale, ...cpClean } = cp;
  const record: TaskCheckpoint = {
    ...cpClean,
    version: 2,
    updatedAt: new Date().toISOString(),
  };
  // Tamper/corruption seal: validated on load (see loadCheckpoint).
  record.checksum = computeCheckpointChecksum(record);

  const targetPath = checkpointPath(projectRoot, cp.id);
  const tmpPath = `${targetPath}.tmp`;
  const content = `${JSON.stringify(record, null, 2)}\n`;

  // 1. Write payload to tmp
  writeFileSync(tmpPath, content, "utf8");

  // 2. fsync tmp file to flush storage write buffers
  try {
    const fd = openSync(tmpPath, "r+");
    fsyncSync(fd);
    closeSync(fd);
  } catch (err) {
    // Fallback if fsync is not supported
  }

  // 3. Atomic rename
  renameSync(tmpPath, targetPath);

  // 4. fsync parent directory descriptor (Unix/macOS specific)
  if (process.platform !== "win32") {
    try {
      const dirFd = openSync(dir, "r");
      fsyncSync(dirFd);
      closeSync(dirFd);
    } catch {
      // Ignored if direct directory fsync is not supported by filesystem
    }
  }
}

export function loadCheckpoint(
  projectRoot: string,
  id: string
): TaskCheckpoint | null {
  const path = checkpointPath(projectRoot, id);
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;

    // Integrity check: a checkpoint carrying a checksum must match it. Legacy
    // checkpoints (no checksum) skip the check so they still load. On mismatch
    // we always warn; the hardened profile additionally rejects (returns null)
    // rather than resuming from a corrupt/tampered half-state.
    if (typeof raw.checksum === "string") {
      const expected = computeCheckpointChecksum(raw);
      if (expected !== raw.checksum) {
        const strict = getRuntimeFlags().checkpointStrict;
        try {
          void EventBus.getInstance().publish("system:warning", {
            message: `⚠ Checkpoint ${id} failed integrity check (checksum mismatch)${strict ? " — rejected" : " — loading anyway (legacy)"}.`,
          });
        } catch {
          /* warning is best-effort */
        }
        if (strict) return null;
      }
    }

    return CheckpointMigrator.migrate(raw);
  } catch (err) {
    // The file exists (we early-returned above otherwise) but couldn't be read
    // or parsed — i.e. a corrupt checkpoint, not an absent one. Surface it so a
    // silently-unrecoverable task is observable, mirroring the checksum-mismatch
    // path above. Best-effort: never let telemetry break the load.
    try {
      void EventBus.getInstance().publish("system:warning", {
        message: `⚠ Checkpoint ${id} is unreadable/corrupt and will be ignored: ${(err as Error)?.message ?? String(err)}`,
      });
    } catch {
      /* observability is best-effort */
    }
    return null;
  }
}

export function listCheckpoints(projectRoot: string): TaskCheckpoint[] {
  const dir = tasksDir(projectRoot);
  if (!existsSync(dir)) return [];
  const results: TaskCheckpoint[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    const id = name.slice(0, -5);
    const cp = loadCheckpoint(projectRoot, id);
    if (cp) results.push(cp);
  }
  return results.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function abortCheckpoint(projectRoot: string, id: string): boolean {
  const cp = loadCheckpoint(projectRoot, id);
  if (!cp) return false;
  if (cp.status === "done") return false;
  saveCheckpoint(projectRoot, { ...cp, status: "aborted" });
  return true;
}
