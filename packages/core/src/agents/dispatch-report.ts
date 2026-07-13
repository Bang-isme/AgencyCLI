import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { AgentDispatchResult, ParallelDispatchResult } from "./orchestrator.js";
import { agentsDir } from "./orchestrator.js";

export interface SubagentTaskReport {
  dispatchId: string;
  label: string;
  agentId: string;
  task: string;
  status: "success" | "failed" | "incomplete" | "skipped";
  exitCode: number;
  summary: string;
  filesWritten?: string[];
  failures?: string;
  elapsedMs: number;
}

export interface ParallelDispatchReport {
  batchId: string;
  batchLabel?: string;
  total: number;
  succeeded: number;
  failed: number;
  mergeSuccess: boolean;
  mergeConflicts?: string[];
  tasks: SubagentTaskReport[];
}

const SUMMARY_MAX = 2048;

function truncateSummary(text: string): string {
  const t = text.trim();
  if (t.length <= SUMMARY_MAX) return t;
  return `${t.slice(0, SUMMARY_MAX)}\n…[truncated]`;
}

function taskStatus(res: AgentDispatchResult): SubagentTaskReport["status"] {
  if (/Skipped:/i.test(res.stderr) || /cost budget exhausted/i.test(res.stderr)) return "skipped";
  if (/tool-loop limit before completing|hit its max loop limit/i.test(res.stderr)) return "incomplete";
  return res.exitCode === 0 ? "success" : "failed";
}

export function buildParallelDispatchReport(
  fanout: ParallelDispatchResult,
  opts: {
    batchId?: string;
    batchLabel?: string;
    labels?: Map<string, string>;
    taskByDispatchId?: Map<string, string>;
    elapsedByDispatchId?: Map<string, number>;
  } = {}
): ParallelDispatchReport {
  const batchId = opts.batchId ?? `batch-${randomUUID()}`;
  const tasks: SubagentTaskReport[] = fanout.results.map((res) => {
    const label =
      opts.labels?.get(res.dispatchId) ??
      res.agentId;
    const task = opts.taskByDispatchId?.get(res.dispatchId) ?? "";
    const summary =
      res.exitCode === 0
        ? truncateSummary(res.stdout || res.payload?.llmResponse || "Completed.")
        : truncateSummary(res.stderr || res.stdout || "Failed.");
    return {
      dispatchId: res.dispatchId,
      label,
      agentId: res.agentId,
      task,
      status: taskStatus(res),
      exitCode: res.exitCode,
      summary,
      filesWritten: res.payload?.filesWritten,
      failures: res.exitCode !== 0 ? truncateSummary(res.stderr || res.stdout) : undefined,
      elapsedMs: opts.elapsedByDispatchId?.get(res.dispatchId) ?? 0,
    };
  });

  const succeeded = tasks.filter((t) => t.status === "success").length;
  const failed = tasks.filter((t) => t.status === "failed" || t.status === "incomplete").length;

  return {
    batchId,
    batchLabel: opts.batchLabel,
    total: tasks.length,
    succeeded,
    failed,
    mergeSuccess: fanout.mergeResult?.success ?? fanout.success,
    mergeConflicts: fanout.mergeResult?.conflicts,
    tasks,
  };
}

export function formatReportForModel(report: ParallelDispatchReport): string {
  const lines: string[] = [
    `[PARALLEL DISPATCH REPORT — batch ${report.batchId}]`,
    report.batchLabel ? `Batch: ${report.batchLabel}` : "",
    `Summary: ${report.succeeded}/${report.total} succeeded, ${report.failed} failed.`,
    report.mergeSuccess ? "Workspace merge: OK" : `Workspace merge: FAILED${report.mergeConflicts?.length ? ` (${report.mergeConflicts.join(", ")})` : ""}`,
    "",
  ].filter(Boolean);

  for (const t of report.tasks) {
    lines.push(`--- Task: ${t.label} (${t.agentId}) [${t.status}] exit=${t.exitCode} ---`);
    lines.push(t.summary);
    if (t.filesWritten?.length) {
      lines.push(`Files: ${t.filesWritten.join(", ")}`);
    }
    if (t.failures) lines.push(`Errors: ${t.failures}`);
    lines.push("");
  }
  return lines.join("\n").trim();
}

export function formatReportForUser(report: ParallelDispatchReport): string {
  const header = report.batchLabel
    ? `**${report.batchLabel}** — ${report.succeeded}/${report.total} tasks succeeded`
    : `${report.succeeded}/${report.total} parallel tasks succeeded`;
  const body = report.tasks
    .map((t) => `- ${t.status === "success" ? "✓" : t.status === "skipped" ? "⊘" : "✗"} **${t.label}** (${t.agentId}): ${t.summary.split("\n")[0]}`)
    .join("\n");
  return `${header}\n\n${body}`;
}

export function persistBatchReport(projectRoot: string, report: ParallelDispatchReport): void {
  try {
    const dir = agentsDir(projectRoot);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${report.batchId}.json`), JSON.stringify(report, null, 2), "utf8");
  } catch {
    /* best-effort */
  }
}
