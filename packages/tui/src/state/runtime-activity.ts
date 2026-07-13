import type { ActivityPhase } from "./context-tracker.js";
import { lifecycleFromToolEvent, type ActionLifecycleEvent } from "@agency/core";

export interface RuntimeActivity {
  id: string;
  name: string;
  action: string;
  target: string;
  status: "active" | "done" | "failed" | "system";
  summary?: string;
  durationMs?: number;
  agentId?: string;
  dispatchId?: string;
  startedAt: number;
  lifecycle?: ActionLifecycleEvent;
}

export function isDisplayTool(name: string): boolean {
  return name !== "update_plan";
}

export function phaseFromToolAction(action: string): ActivityPhase {
  switch (action) {
    case "read":
      return "reading";
    case "write":
      return "writing";
    case "edit":
    case "delete":
    case "move":
      return "editing";
    case "exec":
    case "dispatch":
      return "running";
    case "search":
      return "exploring";
    default:
      return "analyzing";
  }
}

export function latestActiveActivity(activities: RuntimeActivity[]): RuntimeActivity | undefined {
  return [...activities].reverse().find((activity) => activity.status === "active");
}

export function phaseFromActivities(activities: RuntimeActivity[], fallback: ActivityPhase = "idle"): ActivityPhase {
  const active = latestActiveActivity(activities);
  return active ? phaseFromToolAction(active.action) : fallback;
}

export function activityFromToolStarted(payload: any, now = Date.now()): RuntimeActivity | null {
  const name = String(payload.name ?? "tool");
  if (!isDisplayTool(name)) return null;
  const lifecycle = lifecycleFromToolEvent("running", payload, now);
  return {
    id: lifecycle.id,
    name,
    action: String(payload.action ?? "other"),
    target: lifecycle.target ?? "",
    status: "active",
    agentId: payload.agentId ? String(payload.agentId) : "main",
    dispatchId: payload.dispatchId ? String(payload.dispatchId) : undefined,
    startedAt: lifecycle.startedAt ?? now,
    lifecycle,
  };
}

export function reduceToolStarted(
  activities: RuntimeActivity[],
  payload: any,
  now = Date.now()
): RuntimeActivity[] {
  const activity = activityFromToolStarted(payload, now);
  if (!activity) return activities;
  return [...activities.slice(-7), activity];
}

export function reduceToolFinished(
  activities: RuntimeActivity[],
  payload: any,
  ok: boolean,
  now = Date.now()
): RuntimeActivity[] {
  const name = String(payload.name ?? "tool");
  if (!isDisplayTool(name)) return activities;
  const target = String(payload.target ?? "");
  const agentId = payload.agentId ? String(payload.agentId) : "main";
  const dispatchId = payload.dispatchId ? String(payload.dispatchId) : undefined;
  const next = [...activities];
  const idx = [...next].reverse().findIndex((activity) =>
    activity.status === "active" &&
    activity.name === name &&
    activity.target === target &&
    (activity.agentId ?? "main") === agentId &&
    (dispatchId ? activity.dispatchId === dispatchId : true)
  );
  const realIdx = idx >= 0 ? next.length - 1 - idx : -1;
  const completed: RuntimeActivity = {
    id: realIdx >= 0 ? next[realIdx]!.id : `${payload.turnId ?? "turn"}:${name}:${payload.seq ?? now}`,
    name,
    action: String(payload.action ?? "other"),
    target,
    status: ok ? "done" : "failed",
    summary: payload.summary ? String(payload.summary) : undefined,
    durationMs: typeof payload.durationMs === "number" ? payload.durationMs : undefined,
    agentId,
    dispatchId,
    startedAt: realIdx >= 0 ? next[realIdx]!.startedAt : now,
    lifecycle: lifecycleFromToolEvent(ok ? "succeeded" : "failed", payload, now),
  };
  if (realIdx >= 0) {
    next[realIdx] = completed;
    return next.slice(-8);
  }
  return [...next.slice(-7), completed];
}

export function reduceLoopActivity(
  activities: RuntimeActivity[],
  action: string,
  payload: any,
  now = Date.now()
): RuntimeActivity[] {
  const isPaused = action === "loop:paused";
  return [
    ...activities.slice(-7),
    {
      id: `${action}:${now}`,
      name: isPaused ? "Loop paused by mitigation" : "Reflection prompt injected",
      action: "loop",
      target: "",
      status: isPaused ? "failed" : "system",
      summary: isPaused
        ? `${payload.consecutiveFailures ?? "?"} consecutive failures`
        : "strategy reset",
      agentId: payload.agentId ? String(payload.agentId) : "main",
      startedAt: now,
    },
  ];
}
