/**
 * Session handover generator. Produces `.agency/handover.md` so a fresh session
 * (human or agent) can resume with minimal context loss: project status,
 * completed / active / pending tasks, blockers, recent activity, and memory
 * references.
 *
 * Spec: docs/PRODUCTION_AUDIT.md §"SESSION HANDOVER". Pure read of durable
 * state (checkpoints, event journal, memory telemetry) — never mutates.
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { EventBus } from "../events/event-bus.js";
import { listCheckpoints, type TaskCheckpoint } from "../task/checkpoint.js";
import { getRuntimeFlags } from "./flags.js";
import { getMemoryTelemetry } from "./bootstrap.js";

export interface HandoverResult {
  markdown: string;
  path: string;
}

const RECENT_EVENT_LIMIT = 25;

function statusBucket(s: TaskCheckpoint["status"]): "active" | "completed" | "terminated" {
  if (s === "running" || s === "paused") return "active";
  if (s === "done") return "completed";
  return "terminated";
}

function renderTaskLine(cp: TaskCheckpoint): string {
  const done = cp.completed?.length ?? 0;
  return `- \`${cp.id}\` — ${cp.status} · task #${cp.currentTask} · ${done} completed · plan: ${cp.planPath} · updated ${cp.updatedAt}`;
}

/**
 * Builds the handover markdown and writes it to `.agency/handover.md`.
 * `now` is injectable for deterministic tests.
 */
export function generateHandover(projectRoot: string, now: number = Date.now()): HandoverResult {
  const flags = getRuntimeFlags();
  const checkpoints = listCheckpoints(projectRoot);
  const tel = getMemoryTelemetry(projectRoot);
  const journal = EventBus.getInstance().getJournal();

  const active = checkpoints.filter((c) => statusBucket(c.status) === "active");
  const completed = checkpoints.filter((c) => statusBucket(c.status) === "completed");
  const terminated = checkpoints.filter((c) => statusBucket(c.status) === "terminated");

  const lines: string[] = [];
  lines.push(`# AgencyCLI Session Handover`);
  lines.push("");
  lines.push(`_Generated: ${new Date(now).toISOString()} · profile: ${flags.profile}_`);
  lines.push("");

  lines.push(`## Project Status`);
  lines.push(`- Runtime profile: **${flags.profile}**`);
  lines.push(`- Event persistence: ${flags.persistEvents ? "on" : "off"} · auto-recover: ${flags.autoRecover ? "on" : "off"}`);
  if (tel) {
    const mb = (tel.database_size_bytes / (1024 * 1024)).toFixed(1);
    lines.push(`- Memory store: ${tel.episodes_count} episodes · ${tel.vectors_count} vectors · ${tel.graph_edges_count} edges · ${mb} MB`);
  }
  lines.push("");

  lines.push(`## Active / Resumable Tasks (${active.length})`);
  if (active.length) {
    active.forEach((c) => lines.push(renderTaskLine(c)));
    lines.push("");
    lines.push(`> Resume with \`agency task resume <id>\`.`);
  } else {
    lines.push(`_None._`);
  }
  lines.push("");

  lines.push(`## Completed Tasks (${completed.length})`);
  completed.length ? completed.forEach((c) => lines.push(renderTaskLine(c))) : lines.push(`_None._`);
  lines.push("");

  lines.push(`## Terminated / Aborted Tasks (${terminated.length})`);
  terminated.length ? terminated.forEach((c) => lines.push(renderTaskLine(c))) : lines.push(`_None._`);
  lines.push("");

  // Blockers: paused tasks are the explicit human-attention signal.
  const blockers = active.filter((c) => c.status === "paused");
  lines.push(`## Blockers (${blockers.length})`);
  blockers.length
    ? blockers.forEach((c) => lines.push(`- \`${c.id}\` is paused at task #${c.currentTask} — needs attention to resume.`))
    : lines.push(`_None._`);
  lines.push("");

  lines.push(`## Recent Activity (last ${Math.min(RECENT_EVENT_LIMIT, journal.length)} of ${journal.length} events)`);
  if (journal.length) {
    for (const e of journal.slice(-RECENT_EVENT_LIMIT)) {
      const attribution = [
        e.agentId ? `agent:${e.agentId}` : null,
        e.taskId ? `task:${e.taskId}` : null,
        e.durationMs != null ? `${Math.round(e.durationMs)}ms` : null,
        e.costUsd != null ? `$${e.costUsd.toFixed(4)}` : null,
      ].filter(Boolean).join(" ");
      lines.push(`- \`${new Date(e.timestamp).toISOString()}\` **${e.action}**${attribution ? ` _(${attribution})_` : ""}`);
    }
  } else {
    lines.push(`_No events recorded this session._`);
  }
  lines.push("");

  lines.push(`## Memory References`);
  lines.push(`- Event journal: \`.agency/events/journal.db\``);
  lines.push(`- Memory store: \`.agency/memory/memory.db\``);
  lines.push(`- Task checkpoints: \`.agency/tasks/*.json\``);
  lines.push("");

  const markdown = lines.join("\n");

  const dir = join(projectRoot, ".agency");
  const path = join(dir, "handover.md");
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(path, markdown, "utf8");
  } catch {
    // Writing is best-effort; the markdown is still returned for display/use.
  }

  return { markdown, path };
}
