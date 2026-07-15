import type { ReplayEvent } from "@agency/contracts";
import {
  lifecycleFromToolEvent,
  sanitizeLifecycleEvent,
  type ActionLifecycleEvent,
  type ActionLifecycleKind,
  type ActionLifecycleState,
} from "../product/action-lifecycle.js";

function parsePayload(ev: ReplayEvent): any {
  if (!ev.payload) return {};
  try {
    return typeof ev.payload === "string" ? JSON.parse(ev.payload) : ev.payload;
  } catch {
    return typeof ev.payload === "object" ? ev.payload : { raw: ev.payload };
  }
}

/**
 * Converts legacy EventBus events (tool:*, subagent:*, system:warning, plan:updated)
 * into canonical ActionLifecycleEvents at the boundary. ReplayEvent instances that are already
 * canonical (action:lifecycle) are parsed and sanitized directly.
 */
export function convertLegacyEventToCanonical(ev: ReplayEvent): ActionLifecycleEvent | null {
  const p = parsePayload(ev);
  const evAny = ev as any;
  const now = ev.timestamp || Date.now();
  const runId = String(evAny.runId || p.runId || evAny.sessionId || p.sessionId || process.env.AGENCY_RUN_ID || "run-default");
  const turnId = evAny.turnId || p.turnId ? String(evAny.turnId || p.turnId) : undefined;

  // Direct canonical event
  if (ev.action === "action:lifecycle" || ev.action.startsWith("action:")) {
    const rawEvent: ActionLifecycleEvent = typeof p === "object" && p.id && p.kind
      ? p
      : {
          id: String(p.id || `evt-${ev.sequenceId}`),
          runId,
          turnId,
          kind: (p.kind as ActionLifecycleKind) || "tool",
          action: String(p.action || ev.action.replace(/^action:/, "")),
          state: (p.state as ActionLifecycleState) || "succeeded",
          label: String(p.label || p.action || "Runtime Activity"),
          summary: p.summary ? String(p.summary) : undefined,
          evidence: p.evidence,
          timing: p.timing || { startedAt: now, updatedAt: now, elapsedMs: ev.durationMs },
        };
    return sanitizeLifecycleEvent(rawEvent);
  }

  // Legacy tool events
  if (ev.action === "tool:started") {
    return lifecycleFromToolEvent("running", { ...p, runId, turnId, seq: ev.sequenceId, startedAt: now }, now);
  }
  if (ev.action === "tool:finished") {
    return lifecycleFromToolEvent("succeeded", { ...p, runId, turnId, seq: ev.sequenceId, updatedAt: now, durationMs: ev.durationMs }, now);
  }
  if (ev.action === "tool:failed") {
    return lifecycleFromToolEvent("failed", { ...p, runId, turnId, seq: ev.sequenceId, updatedAt: now, durationMs: ev.durationMs }, now);
  }

  // Legacy subagent events
  if (ev.action === "subagent:started") {
    return sanitizeLifecycleEvent({
      id: `${runId}:${turnId || "turn"}:subagent:${String(p.agentId || "agent")}:${ev.sequenceId}`,
      runId,
      turnId,
      agentId: p.agentId ? String(p.agentId) : undefined,
      kind: "agent",
      action: "dispatch_subagent",
      state: "running",
      label: `Subagent ${p.agentId || "worker"}`,
      target: p.agentId ? String(p.agentId) : undefined,
      timing: { startedAt: now, updatedAt: now },
      startedAt: now,
      summary: typeof p.task === "string" ? p.task : "Dispatched subagent task",
    });
  }
  if (ev.action === "subagent:progress") {
    return sanitizeLifecycleEvent({
      id: `${runId}:${turnId || "turn"}:subagent:${String(p.agentId || "agent")}:${ev.sequenceId}`,
      runId,
      turnId,
      agentId: p.agentId ? String(p.agentId) : undefined,
      kind: "agent",
      action: "dispatch_subagent",
      state: "running",
      label: `Subagent ${p.agentId || "worker"}`,
      target: p.agentId ? String(p.agentId) : undefined,
      timing: { startedAt: now, updatedAt: now, elapsedMs: typeof p.elapsedMs === "number" ? p.elapsedMs : undefined },
      summary: typeof p.phase === "string" ? `Phase: ${p.phase}` : undefined,
    });
  }
  if (ev.action === "subagent:finished") {
    return sanitizeLifecycleEvent({
      id: `${runId}:${turnId || "turn"}:subagent:${String(p.agentId || "agent")}:${ev.sequenceId}`,
      runId,
      turnId,
      agentId: p.agentId ? String(p.agentId) : undefined,
      kind: "agent",
      action: "dispatch_subagent",
      state: "succeeded",
      label: `Subagent ${p.agentId || "worker"}`,
      target: p.agentId ? String(p.agentId) : undefined,
      timing: { updatedAt: now, elapsedMs: typeof p.elapsedMs === "number" ? p.elapsedMs : undefined },
      summary: `Completed with exit code ${p.exitCode ?? 0}`,
    });
  }
  if (ev.action === "subagent:error") {
    return sanitizeLifecycleEvent({
      id: `${runId}:${turnId || "turn"}:subagent:${String(p.agentId || "agent")}:${ev.sequenceId}`,
      runId,
      turnId,
      agentId: p.agentId ? String(p.agentId) : undefined,
      kind: "agent",
      action: "dispatch_subagent",
      state: "failed",
      label: `Subagent ${p.agentId || "worker"}`,
      target: p.agentId ? String(p.agentId) : undefined,
      timing: { updatedAt: now },
      summary: typeof p.error === "string" ? p.error : "Subagent execution error",
      recoveryHint: { suggestion: "Inspect subagent logs and retry dispatch.", autoRecoverable: false },
    });
  }
  if (ev.action === "subagent:skipped") {
    return sanitizeLifecycleEvent({
      id: `${runId}:${turnId || "turn"}:subagent:${String(p.agentId || "agent")}:${ev.sequenceId}`,
      runId,
      turnId,
      agentId: p.agentId ? String(p.agentId) : undefined,
      kind: "agent",
      action: "dispatch_subagent",
      state: "incomplete",
      label: `Subagent ${p.agentId || "worker"}`,
      target: p.agentId ? String(p.agentId) : undefined,
      summary: "Subagent execution skipped",
    });
  }

  // System warnings / notices
  if (ev.action === "system:warning") {
    const isCircuitBreaker = typeof p?.message === "string" && p.message.includes("circuit breaker");
    return sanitizeLifecycleEvent({
      id: `${runId}:${turnId || "turn"}:warning:${ev.sequenceId}`,
      runId,
      turnId,
      kind: isCircuitBreaker ? "loop" : "verification",
      action: isCircuitBreaker ? "circuit_breaker" : "system_warning",
      state: "failed",
      label: isCircuitBreaker ? "Circuit Breaker Tripped" : "System Warning",
      summary: typeof p?.message === "string" ? p.message : "Warning emitted",
      timing: { startedAt: now, updatedAt: now },
      recoveryHint: isCircuitBreaker ? { suggestion: "Stop repeating identical calls and inspect workspace state.", autoRecoverable: false } : undefined,
    });
  }

  return null;
}
