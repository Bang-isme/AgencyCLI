import { describeToolCapability, capabilityRegistry } from "./capabilities.js";
import { EventBus } from "../events/event-bus.js";
import type { VerificationResult } from "./verification.js";

export const ACTION_LIFECYCLE_TOPIC = "action:lifecycle";
export const ACTION_QUEUED_TOPIC = "action:queued";
export const ACTION_RUNNING_TOPIC = "action:running";
export const ACTION_SUCCEEDED_TOPIC = "action:succeeded";
export const ACTION_FAILED_TOPIC = "action:failed";
export const ACTION_INCOMPLETE_TOPIC = "action:incomplete";
export const ACTION_CANCELLED_TOPIC = "action:cancelled";

export type ActionLifecycleState =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "incomplete"
  | "cancelled";

export type ActionSemanticCategory =
  | "fs"
  | "exec"
  | "search"
  | "agent"
  | "memory"
  | "review"
  | "other";

export type ActionSemanticOperation =
  | "read"
  | "write"
  | "edit"
  | "delete"
  | "move"
  | "exec"
  | "search"
  | "dispatch"
  | "remember"
  | "other";

export interface ActionSemanticDetail {
  category: ActionSemanticCategory;
  operation: ActionSemanticOperation;
  label: string;
  description?: string;
}

export type ActionVerificationStatus = "unverified" | "verified" | "verification_failed" | "skipped";

export interface ActionVerificationState {
  status: ActionVerificationStatus;
  verifier?: "linter" | "compiler" | "test_runner" | "git_status" | "circuit_breaker" | "custom";
  message?: string;
  gateResult?: VerificationResult;
}

export interface ActionRecoveryHint {
  code?: string;
  suggestion: string;
  autoRecoverable: boolean;
  suggestedAction?: string;
}

export interface ActionLifecycleEvent {
  /** Unique execution instance ID (e.g., "turn-123:write_file:seq-4") */
  id: string;
  /** Turn or session correlation ID */
  turnId?: string;
  /** Monotonic sequence ID within turn */
  seq?: number;
  /** Agent / worker attribution */
  agentId?: string;
  /** Subagent dispatch correlation handle */
  dispatchId?: string;
  /** Task ID in DAG / plan */
  taskId?: string;

  /** Canonical raw tool/action name (e.g., "replace_file_content", "dispatch_subagent") */
  action: string;
  /** Strict lifecycle state */
  state: ActionLifecycleState;

  /** Human-friendly label for display */
  label: string;
  /** Grounded target resource (file path, shell command, worker ID) */
  target?: string;

  /** Grounded semantic descriptor (category, operation, label) */
  semantic?: ActionSemanticDetail;

  /** Timing metrics */
  startedAt?: number;
  updatedAt?: number;
  durationMs?: number;
  elapsedMs?: number;

  /** Concise result summary for UI timeline */
  summary?: string;

  /** Complete raw detail or spilled payload reference */
  rawDetail?: string | { refId: string; summary: string };

  /** Structured verification state */
  verificationState?: ActionVerificationState;

  /** Actionable recovery advice */
  recoveryHint?: ActionRecoveryHint;
  /** Legacy alias for recovery hint message */
  recovery?: string;

  /** Additional attribution metadata */
  meta?: Record<string, unknown>;
}

/** Windows package/process identifiers are implementation details, not user work. */
export function isOpaqueRuntimeTarget(target: string | undefined): boolean {
  if (!target) return false;
  return /(?:^OpenJS\.NodeJS\.|Microsoft\.Winget\.|_8we(?:$|\b))/i.test(target);
}

/** Helper to publish an ActionLifecycleEvent to topic action:lifecycle and strict state topic. */
export function publishActionLifecycle(event: ActionLifecycleEvent): void {
  const bus = EventBus.getInstance();
  void bus.publish(ACTION_LIFECYCLE_TOPIC, event);
  void bus.publish(`action:${event.state}`, event);
}

/** Converts existing EventBus tool payloads at one boundary; TUI never parses raw tool names. */
export function lifecycleFromToolEvent(
  state: ActionLifecycleState,
  payload: Record<string, unknown>,
  now = Date.now()
): ActionLifecycleEvent {
  const action = String(payload.name ?? payload.action ?? "tool");
  const target = payload.target ? String(payload.target) : undefined;
  const capability = describeToolCapability(action, String(payload.action ?? "other"));
  const displayTarget = isOpaqueRuntimeTarget(target) ? undefined : target;
  const label = displayTarget
    ? `${capability.label} ${displayTarget.split(/[\\/]/).pop() || displayTarget}`
    : capability.label;

  const pStartedAt = typeof payload.startedAt === "number" ? payload.startedAt : undefined;
  const pUpdatedAt = typeof payload.updatedAt === "number" ? payload.updatedAt : undefined;
  const startedAt = pStartedAt ?? now;
  const updatedAt = pUpdatedAt ?? now;
  const durationMs = typeof payload.durationMs === "number"
    ? payload.durationMs
    : (pUpdatedAt !== undefined && pStartedAt !== undefined
        ? pUpdatedAt - pStartedAt
        : (now - (pStartedAt ?? now)));
  const elapsedMs = typeof payload.elapsedMs === "number" ? payload.elapsedMs : durationMs;

  const fullCap = capabilityRegistry.get(action);
  const recoveryMessage = state === "failed" || state === "incomplete"
    ? (fullCap?.recoveryAction ?? fullCap?.recovery ?? "Inspect details and retry or resume from the saved workspace state.")
    : undefined;

  const semantic: ActionSemanticDetail = (payload.semantic as ActionSemanticDetail) ?? {
    category: (payload.category as ActionSemanticCategory) ?? (capability.category === "workspace" || capability.category === "review" ? "fs" : "other"),
    operation: (payload.action as ActionSemanticOperation) ?? "other",
    label: capability.label,
    description: capability.description,
  };

  const rawDetailVal = payload.rawDetail
    ? (typeof payload.rawDetail === "string" ? payload.rawDetail : payload.rawDetail as { refId: string; summary: string })
    : undefined;

  return {
    id: String(payload.id ?? `${String(payload.turnId ?? "turn")}:${action}:${target ?? ""}:${String(payload.seq ?? now)}`),
    turnId: payload.turnId ? String(payload.turnId) : undefined,
    seq: typeof payload.seq === "number" ? payload.seq : undefined,
    agentId: payload.agentId ? String(payload.agentId) : undefined,
    dispatchId: payload.dispatchId ? String(payload.dispatchId) : undefined,
    taskId: payload.taskId ? String(payload.taskId) : undefined,
    action,
    state,
    label,
    target: displayTarget,
    semantic,
    startedAt,
    updatedAt,
    durationMs,
    elapsedMs,
    summary: payload.summary ? String(payload.summary) : undefined,
    rawDetail: rawDetailVal,
    verificationState: payload.verificationState as ActionVerificationState | undefined,
    recoveryHint: payload.recoveryHint as ActionRecoveryHint | undefined ?? (recoveryMessage ? { suggestion: recoveryMessage, autoRecoverable: false } : undefined),
    recovery: recoveryMessage,
    meta: payload.meta as Record<string, unknown> | undefined,
  };
}

