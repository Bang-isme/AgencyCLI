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

export type ActionLifecycleKind =
  | "context"
  | "memory"
  | "tool"
  | "loop"
  | "verification"
  | "hook"
  | "agent";

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

export interface ActionTimingMetrics {
  startedAt?: number;
  updatedAt?: number;
  durationMs?: number;
  elapsedMs?: number;
}

export interface ActionEvidence {
  files?: string[];
  gateResult?: any;
  artifactPath?: string;
  selectedMemoryIds?: string[];
  parserDiagnostic?: string;
  target?: string;
  detail?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface RunContext {
  runId: string;
  sessionId?: string;
  turnId?: string;
  parentId?: string;
  agentId?: string;
  dispatchId?: string;
}

export interface ActionLifecycleEvent {
  /** Unique execution instance ID (e.g., "run-123:toolCall-456") */
  id: string;
  /** Run correlation ID */
  runId: string;
  /** Turn or session correlation ID */
  turnId?: string;
  /** Parent execution instance ID if nested */
  parentId?: string;
  /** Monotonic sequence ID within turn */
  seq?: number;
  /** Agent / worker attribution */
  agentId?: string;
  /** Subagent dispatch correlation handle */
  dispatchId?: string;
  /** Task ID in DAG / plan */
  taskId?: string;

  /** Canonical kind of runtime activity */
  kind: ActionLifecycleKind;
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
  timing?: ActionTimingMetrics;
  startedAt?: number;
  updatedAt?: number;
  durationMs?: number;
  elapsedMs?: number;

  /** Concise result summary for UI timeline */
  summary?: string;

  /** Complete raw detail or spilled payload reference */
  rawDetail?: string | { refId: string; summary: string };

  /** Sanitized structured evidence (no secrets, no raw provider payloads) */
  evidence?: ActionEvidence;

  /** Risk assessment */
  risk?: "low" | "medium" | "high" | "critical";

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

/** Redacts secrets and raw process titles from lifecycle events before persist/emit. */
export function sanitizeLifecycleEvent(event: ActionLifecycleEvent): ActionLifecycleEvent {
  const target = isOpaqueRuntimeTarget(event.target) ? undefined : event.target;
  const label = isOpaqueRuntimeTarget(event.target) && event.label.includes("OpenJS")
    ? "Runtime Process"
    : event.label;

  const MAX_STRING_LEN = 1024;
  const MAX_RAW_DETAIL_LEN = 512;

  const sanitizeString = (str?: string, maxLen = MAX_STRING_LEN): string | undefined => {
    if (!str) return str;
    let s = str;
    // Redact common secret formats (API keys, Bearer tokens, passwords, authorization headers)
    s = s.replace(/\b(?:sk-[a-zA-Z0-9_-]{20,}|AIza[a-zA-Z0-9_-]{35}|gsk_[a-zA-Z0-9_-]{20,}|Bearer\s+[a-zA-Z0-9._-]{20,})\b/g, "[REDACTED_SECRET]");
    s = s.replace(/((?:api_key|password|secret|auth_token|authorization|access_token)\s*[:=]\s*["'])[^"']+(["'])/gi, "$1[REDACTED]$2");
    if (s.length > maxLen) {
      s = `${s.slice(0, maxLen)}... [TRUNCATED ${s.length - maxLen} chars]`;
    }
    return s;
  };

  const sanitizeObj = (obj: any, depth = 0): any => {
    if (!obj || typeof obj !== "object" || depth > 5) return obj;
    if (Array.isArray(obj)) return obj.map((item) => sanitizeObj(item, depth + 1));
    const result: Record<string, any> = {};
    for (const [key, val] of Object.entries(obj)) {
      if (/secret|password|auth_token|access_token|key|authorization|bearer/i.test(key)) {
        result[key] = "[REDACTED]";
      } else if (typeof val === "string") {
        result[key] = sanitizeString(val);
      } else if (typeof val === "object") {
        result[key] = sanitizeObj(val, depth + 1);
      } else {
        result[key] = val;
      }
    }
    return result;
  };

  let rawDetail: string | { refId: string; summary: string } | undefined;
  if (typeof event.rawDetail === "string") {
    rawDetail = sanitizeString(event.rawDetail, MAX_RAW_DETAIL_LEN);
  } else if (event.rawDetail && typeof event.rawDetail === "object") {
    rawDetail = {
      refId: String(event.rawDetail.refId || "ref-summary"),
      summary: sanitizeString(event.rawDetail.summary, MAX_RAW_DETAIL_LEN) || "Raw detail summary",
    };
  }

  const evidence = event.evidence ? sanitizeObj(event.evidence) : undefined;
  if (evidence && target !== undefined) {
    evidence.target = target;
  }

  return {
    ...event,
    target,
    label,
    summary: sanitizeString(event.summary),
    recovery: sanitizeString(event.recovery),
    rawDetail,
    evidence,
    meta: event.meta ? sanitizeObj(event.meta) : undefined,
  };
}

/** Helper to publish an ActionLifecycleEvent to topic action:lifecycle and strict state topic. */
export function publishActionLifecycle(event: ActionLifecycleEvent): void {
  const sanitized = sanitizeLifecycleEvent(event);
  const bus = EventBus.getInstance();
  void bus.publish(ACTION_LIFECYCLE_TOPIC, sanitized);
  void bus.publish(`action:${sanitized.state}`, sanitized);
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

  const runId = String(payload.runId ?? payload.sessionId ?? "run-legacy");
  const toolCallId = String(payload.toolCallId ?? payload.operationId ?? payload.callId ?? action);
  const kind: ActionLifecycleKind = payload.kind
    ? (payload.kind as ActionLifecycleKind)
    : capability.category === "automation"
      ? "agent"
      : (action.includes("memory") || action.includes("remember") || action.includes("forget"))
        ? "memory"
        : "tool";

  const rawEvidence = (payload.evidence as ActionEvidence) ?? {
    target: displayTarget,
    detail: typeof payload.summary === "string" ? { summary: payload.summary } : undefined,
  };

  return sanitizeLifecycleEvent({
    id: String(payload.id ?? `${runId}:${String(payload.turnId ?? "turn")}:${toolCallId}`),
    runId,
    turnId: payload.turnId ? String(payload.turnId) : undefined,
    parentId: payload.parentId ? String(payload.parentId) : undefined,
    seq: typeof payload.seq === "number" ? payload.seq : undefined,
    agentId: payload.agentId ? String(payload.agentId) : undefined,
    dispatchId: payload.dispatchId ? String(payload.dispatchId) : undefined,
    taskId: payload.taskId ? String(payload.taskId) : undefined,
    kind,
    action,
    state,
    label,
    target: displayTarget,
    semantic,
    timing: { startedAt, updatedAt, durationMs, elapsedMs },
    startedAt,
    updatedAt,
    durationMs,
    elapsedMs,
    summary: payload.summary ? String(payload.summary) : undefined,
    rawDetail: rawDetailVal,
    evidence: rawEvidence,
    risk: (payload.risk as any) ?? (fullCap?.risk === "high" ? "high" : "low"),
    verificationState: payload.verificationState as ActionVerificationState | undefined,
    recoveryHint: payload.recoveryHint as ActionRecoveryHint | undefined ?? (recoveryMessage ? { suggestion: recoveryMessage, autoRecoverable: false } : undefined),
    recovery: recoveryMessage,
    meta: payload.meta as Record<string, unknown> | undefined,
  });
}

