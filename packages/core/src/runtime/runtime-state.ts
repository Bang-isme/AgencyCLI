import { existsSync } from "node:fs";
import { ReplayEvent } from "@agency/contracts";
import { EventJournal } from "../events/event-journal.js";

/**
 * RuntimeState — the first-class, journal-derived view of what the runtime has
 * been doing (AGENT_OS_BLUEPRINT.md K1 / EVENT_FIRST_RUNTIME.md §3).
 *
 * It is a PURE reducer over the EventBus journal (already persisted via
 * `persistEvents`), so it adds no write path and is replay-deterministic: the
 * same events always fold to the same state. This single reducer is the shared
 * source the headless `agency status` consumes today, and the Activity Timeline /
 * Tasks panels and the supervisor will fold tomorrow — do NOT add a second state
 * derivation; extend `reduceRuntimeState`.
 *
 * It deliberately derives state ONLY from events that already exist on the bus
 * (`tool:*`, `plan:updated`, `subagent:*`, `continuation:started`,
 * `system:warning`) — no new emission is introduced here.
 */

export interface RuntimePlanItem {
  step: string;
  status: "pending" | "in_progress" | "completed";
}

export interface RuntimeAgentState {
  agentId: string;
  status: "running" | "done" | "error" | "skipped";
  task?: string;
  phase?: string;
  elapsedMs?: number;
  exitCode?: number;
}

export interface RuntimeToolStats {
  /** Tool calls started this journal. */
  total: number;
  /** Calls whose result reported a failure (`tool:failed`). */
  failed: number;
  /** Started-call counts keyed by coarse category (fs/exec/search/agent/memory/other). */
  byCategory: Record<string, number>;
  /** The most recently completed/failed call. */
  last?: { name: string; ok: boolean; target?: string; summary?: string };
}

import { convertLegacyEventToCanonical } from "./legacy-event-migration.js";
import type { ActionLifecycleEvent } from "../product/action-lifecycle.js";

export interface RuntimeState {
  /** Total events folded. */
  eventCount: number;
  /** Highest event sequence id seen (monotonic). */
  lastSeq: number;
  /** Latest event timestamp (epoch ms). */
  lastTimestamp: number;
  /** The latest `update_plan` todo list (latest `plan:updated` wins). */
  plan: RuntimePlanItem[];
  planProgress: { completed: number; inProgress: number; pending: number };
  /** Unique files written/edited/deleted/moved by successful tool calls. */
  modifiedFiles: string[];
  tools: RuntimeToolStats;
  /** Latest known state per dispatched agent id. */
  agents: RuntimeAgentState[];
  /** Number of invisible loop-budget extensions (`continuation:started`). */
  continuations: number;
  /** Number of `system:warning` events. */
  warnings: number;
  lastWarning?: string;
  /** Sum of attributed durations on terminal events (best-effort). */
  totalDurationMs: number;
  /** Sum of attributed cost on terminal events (best-effort, USD). */
  totalCostUsd: number;
  /** Active in-flight lifecycle events (`running` or `queued` state). */
  activeWork?: ActionLifecycleEvent[];
  /** Chronological history of canonical ActionLifecycleEvents. */
  latestCanonicalEvents?: ActionLifecycleEvent[];
}



function parsePayload(ev: ReplayEvent): any {
  try {
    return typeof ev.payload === "string" ? JSON.parse(ev.payload) : ev.payload;
  } catch {
    return undefined;
  }
}

function upsertAgent(
  agents: Map<string, RuntimeAgentState>,
  agentId: string,
  patch: Partial<RuntimeAgentState>
): void {
  const existing = agents.get(agentId);
  if (existing) {
    Object.assign(existing, patch);
  } else {
    agents.set(agentId, { agentId, status: "running", ...patch });
  }
}

/**
 * Folds a chronological event list into {@link RuntimeState}. Pure and total —
 * malformed payloads are skipped, unknown actions are ignored, an empty list
 * yields a well-formed empty state.
 */
export function reduceRuntimeState(events: ReplayEvent[]): RuntimeState {
  const tools: RuntimeToolStats = { total: 0, failed: 0, byCategory: {} };
  const modified = new Set<string>();
  const agents = new Map<string, RuntimeAgentState>();
  const activeWorkMap = new Map<string, ActionLifecycleEvent>();
  const latestCanonicalEvents: ActionLifecycleEvent[] = [];

  let plan: RuntimePlanItem[] = [];
  let continuations = 0;
  let warnings = 0;
  let lastWarning: string | undefined;
  let lastSeq = 0;
  let lastTimestamp = 0;
  let totalDurationMs = 0;
  let totalCostUsd = 0;
  let eventCount = 0;

  for (const ev of events) {
    eventCount++;
    if (ev.sequenceId > lastSeq) lastSeq = ev.sequenceId;
    if (ev.timestamp > lastTimestamp) lastTimestamp = ev.timestamp;
    if (typeof ev.durationMs === "number") totalDurationMs += ev.durationMs;
    if (typeof ev.costUsd === "number") totalCostUsd += ev.costUsd;

    const p = parsePayload(ev);

    // Single migration adapter for legacy & canonical events -> ActionLifecycleEvent
    const canonical = convertLegacyEventToCanonical(ev);
    if (canonical) {
      latestCanonicalEvents.push(canonical);
      if (canonical.state === "running" || canonical.state === "queued") {
        activeWorkMap.set(canonical.id, canonical);
      } else {
        activeWorkMap.delete(canonical.id);
      }

      if (canonical.kind === "tool") {
        if (canonical.state === "running") {
          tools.total++;
          const cat = canonical.semantic?.category ?? "other";
          tools.byCategory[cat] = (tools.byCategory[cat] ?? 0) + 1;
        } else if (canonical.state === "succeeded" || canonical.state === "failed" || canonical.state === "incomplete" || canonical.state === "cancelled") {
          const ok = canonical.state === "succeeded";
          if (!ok) tools.failed++;
          tools.last = {
            name: canonical.action,
            ok,
            target: canonical.target,
            summary: canonical.summary,
          };
          if (ok && canonical.target && (canonical.semantic?.operation === "write" || canonical.semantic?.operation === "edit" || canonical.semantic?.operation === "delete" || canonical.semantic?.operation === "move")) {
            modified.add(canonical.target);
          }
        }
      } else if (canonical.kind === "agent") {
        const agentId = canonical.agentId || canonical.target || "worker";
        const evDetail = canonical.evidence || {};
        if (canonical.state === "running") {
          upsertAgent(agents, agentId, {
            status: "running",
            ...(typeof evDetail.task === "string" ? { task: evDetail.task } : (canonical.summary && !canonical.summary.startsWith("Phase:") ? { task: canonical.summary } : {})),
            ...(typeof evDetail.phase === "string" ? { phase: evDetail.phase } : {}),
            ...(typeof canonical.timing?.elapsedMs === "number" ? { elapsedMs: canonical.timing.elapsedMs } : {}),
          });
        } else if (canonical.state === "succeeded") {
          upsertAgent(agents, agentId, {
            status: "done",
            exitCode: typeof evDetail.exitCode === "number" ? evDetail.exitCode : 0,
            ...(typeof canonical.timing?.elapsedMs === "number" ? { elapsedMs: canonical.timing.elapsedMs } : {}),
          });
        } else if (canonical.state === "failed") {
          upsertAgent(agents, agentId, {
            status: "error",
            exitCode: typeof evDetail.exitCode === "number" ? evDetail.exitCode : 1,
          });
        } else if (canonical.state === "incomplete" || canonical.state === "cancelled") {
          upsertAgent(agents, agentId, {
            status: "skipped",
          });
        }
      }
    }

    switch (ev.action) {
      case "plan:updated": {
        if (Array.isArray(p?.todos)) {
          plan = p.todos
            .map((t: any) => {
              const step = String(t?.step ?? "").trim();
              const status =
                t?.status === "completed" || t?.status === "in_progress"
                  ? t.status
                  : "pending";
              return { step, status } as RuntimePlanItem;
            })
            .filter((t: RuntimePlanItem) => t.step.length > 0);
        }
        break;
      }
      case "continuation:started":
        continuations++;
        break;
      case "system:warning":
        warnings++;
        if (typeof p?.message === "string") lastWarning = p.message;
        break;
    }
  }

  const planProgress = {
    completed: plan.filter((t) => t.status === "completed").length,
    inProgress: plan.filter((t) => t.status === "in_progress").length,
    pending: plan.filter((t) => t.status === "pending").length,
  };

  return {
    eventCount,
    lastSeq,
    lastTimestamp,
    plan,
    planProgress,
    modifiedFiles: Array.from(modified),
    tools,
    agents: Array.from(agents.values()),
    continuations,
    warnings,
    lastWarning,
    totalDurationMs,
    totalCostUsd,
    activeWork: Array.from(activeWorkMap.values()),
    latestCanonicalEvents,
  };
}

/**
 * Loads the durable journal for a project root and folds it into RuntimeState.
 * Read-only: if no journal exists yet it returns the empty state without
 * creating one (so a `agency status` read has no side effect). Reuses
 * {@link EventJournal} (the single journal home) rather than re-deriving the path.
 */
export function loadRuntimeState(projectRoot: string): RuntimeState {
  const path = EventJournal.resolvePath(projectRoot);
  if (path !== ":memory:" && !existsSync(path)) {
    return reduceRuntimeState([]);
  }
  const journal = new EventJournal(projectRoot);
  try {
    return reduceRuntimeState(journal.readEvents());
  } finally {
    journal.close();
  }
}
