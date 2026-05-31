import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { ApprovalRequiredError } from "../approval/policy.js";
import { resolveSkillsRoot } from "../skills-root.js";
import {
  isWorkflowName,
  runWorkflow,
  type WorkflowName,
} from "../workflow/compose.js";

const WORKFLOW_NAMES = [
  "create",
  "debug",
  "review",
  "deploy",
  "plan",
  "handoff",
  "refactor",
  "prototype",
] as const;

export const ScheduleEntrySchema = z.object({
  id: z.string().min(1),
  workflow: z.enum(WORKFLOW_NAMES),
  cron: z.string().min(1),
  projectRoot: z.string().min(1),
  enabled: z.boolean(),
  requireApproval: z.boolean(),
  lastRun: z.string().optional(),
  nextRun: z.string().optional(),
});

export const SchedulesFileSchema = z.object({
  version: z.literal(1),
  schedules: z.array(ScheduleEntrySchema),
});

export type ScheduleEntry = z.infer<typeof ScheduleEntrySchema>;
export type SchedulesFile = z.infer<typeof SchedulesFileSchema>;

export class ScheduleNotFoundError extends Error {
  constructor(id: string) {
    super(`Schedule not found: ${id}`);
    this.name = "ScheduleNotFoundError";
  }
}

export interface AddScheduleInput {
  workflow: WorkflowName;
  cron: string;
  projectRoot: string;
  enabled?: boolean;
  requireApproval?: boolean;
}

export interface RunDueSchedulesOptions {
  yes?: boolean;
}

export interface RunDueScheduleResult {
  id: string;
  workflow: WorkflowName;
  status: "ok" | "failed" | "skipped";
  reason?: string;
}

export function schedulesPath(projectRoot: string): string {
  return join(projectRoot, ".agency", "schedules.json");
}

export function loadSchedules(projectRoot: string): SchedulesFile {
  const path = schedulesPath(projectRoot);
  if (!existsSync(path)) {
    return { version: 1, schedules: [] };
  }
  const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
  return SchedulesFileSchema.parse(raw);
}

export function saveSchedules(projectRoot: string, data: SchedulesFile): void {
  const validated = SchedulesFileSchema.parse(data);
  const dir = join(projectRoot, ".agency");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    schedulesPath(projectRoot),
    `${JSON.stringify(validated, null, 2)}\n`,
    "utf8"
  );
}

function newScheduleId(): string {
  return `sched-${randomBytes(4).toString("hex")}`;
}

export function listSchedules(projectRoot: string): ScheduleEntry[] {
  return loadSchedules(projectRoot).schedules;
}

export function addSchedule(
  storageRoot: string,
  input: AddScheduleInput
): ScheduleEntry {
  if (!isWorkflowName(input.workflow)) {
    throw new Error(`Unknown workflow: ${input.workflow}`);
  }
  const next = parseCronNext(input.cron, new Date());
  if (!next) {
    throw new Error(`Invalid or unsupported cron expression: ${input.cron}`);
  }

  const data = loadSchedules(storageRoot);
  const entry: ScheduleEntry = {
    id: newScheduleId(),
    workflow: input.workflow,
    cron: input.cron,
    projectRoot: input.projectRoot,
    enabled: input.enabled ?? true,
    requireApproval: input.requireApproval ?? false,
    nextRun: next.toISOString(),
  };
  saveSchedules(storageRoot, {
    ...data,
    schedules: [...data.schedules, entry],
  });
  return entry;
}

export function removeSchedule(storageRoot: string, id: string): void {
  const data = loadSchedules(storageRoot);
  if (!data.schedules.some((s) => s.id === id)) {
    throw new ScheduleNotFoundError(id);
  }
  saveSchedules(storageRoot, {
    ...data,
    schedules: data.schedules.filter((s) => s.id !== id),
  });
}

const EVERY_RE = /^every:(\d+)(m|h)$/i;
const DAILY_RE = /^daily:(\d{1,2}):(\d{2})$/i;

function parseEveryCron(cron: string, from: Date): Date | null {
  const match = cron.trim().match(EVERY_RE);
  if (!match) return null;
  const amount = parseInt(match[1]!, 10);
  const unit = match[2]!.toLowerCase();
  if (!Number.isFinite(amount) || amount <= 0) return null;
  const ms = unit === "m" ? amount * 60_000 : amount * 3_600_000;
  return new Date(from.getTime() + ms);
}

function parseDailyCron(cron: string, from: Date): Date | null {
  const match = cron.trim().match(DAILY_RE);
  if (!match) return null;
  const hour = parseInt(match[1]!, 10);
  const minute = parseInt(match[2]!, 10);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;

  const candidate = new Date(from);
  candidate.setSeconds(0, 0);
  candidate.setHours(hour, minute, 0, 0);
  if (candidate.getTime() <= from.getTime()) {
    candidate.setDate(candidate.getDate() + 1);
  }
  return candidate;
}

function cronFieldMatches(field: string, value: number): boolean {
  if (field === "*") return true;

  for (const part of field.split(",")) {
    const stepMatch = part.match(/^(.+)\/(\d+)$/);
    const base = stepMatch ? stepMatch[1]! : part;
    const step = stepMatch ? parseInt(stepMatch[2]!, 10) : 1;
    if (!Number.isFinite(step) || step <= 0) continue;

    const rangeMatch = base.match(/^(\d+)-(\d+)$/);
    if (rangeMatch) {
      const start = parseInt(rangeMatch[1]!, 10);
      const end = parseInt(rangeMatch[2]!, 10);
      for (let i = start; i <= end; i += step) {
        if (i === value) return true;
      }
      continue;
    }

    if (base === "*") {
      if (value % step === 0) return true;
      continue;
    }

    const exact = parseInt(base, 10);
    if (Number.isFinite(exact) && exact === value && value % step === 0) {
      return true;
    }
  }

  return false;
}

function parseStandardCronNext(cron: string, from: Date): Date | null {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [minute, hour, day, month, weekday] = parts as [
    string,
    string,
    string,
    string,
    string,
  ];

  const start = new Date(from);
  start.setSeconds(0, 0);
  start.setMilliseconds(0);
  start.setMinutes(start.getMinutes() + 1);

  const limit = start.getTime() + 366 * 24 * 60 * 60_000;
  for (let t = start.getTime(); t < limit; t += 60_000) {
    const d = new Date(t);
    const dom = d.getDate();
    const mon = d.getMonth() + 1;
    const dow = d.getDay();
    const min = d.getMinutes();
    const hr = d.getHours();

    if (
      cronFieldMatches(minute, min) &&
      cronFieldMatches(hour, hr) &&
      cronFieldMatches(day, dom) &&
      cronFieldMatches(month, mon) &&
      cronFieldMatches(weekday, dow)
    ) {
      return d;
    }
  }
  return null;
}

export function parseCronNext(cron: string, from: Date): Date | null {
  const trimmed = cron.trim();
  return (
    parseEveryCron(trimmed, from) ??
    parseDailyCron(trimmed, from) ??
    parseStandardCronNext(trimmed, from)
  );
}

function isScheduleDue(entry: ScheduleEntry, now: Date): boolean {
  if (!entry.enabled) return false;
  if (!entry.nextRun) return true;
  return new Date(entry.nextRun).getTime() <= now.getTime();
}

function touchScheduleRun(
  storageRoot: string,
  entry: ScheduleEntry,
  ranAt: Date
): void {
  const data = loadSchedules(storageRoot);
  const next = parseCronNext(entry.cron, ranAt);
  const updated = data.schedules.map((s) =>
    s.id === entry.id
      ? {
          ...s,
          lastRun: ranAt.toISOString(),
          nextRun: next?.toISOString(),
        }
      : s
  );
  saveSchedules(storageRoot, { ...data, schedules: updated });
}

export async function runDueSchedules(
  storageRoot: string,
  opts: RunDueSchedulesOptions = {}
): Promise<RunDueScheduleResult[]> {
  const data = loadSchedules(storageRoot);
  const now = new Date();
  const skillsRoot = resolveSkillsRoot();
  const results: RunDueScheduleResult[] = [];

  for (const entry of data.schedules) {
    if (!isScheduleDue(entry, now)) continue;

    if (entry.requireApproval && !opts.yes) {
      results.push({
        id: entry.id,
        workflow: entry.workflow,
        status: "skipped",
        reason: "requires approval (--yes)",
      });
      continue;
    }

    try {
      const { status } = await runWorkflow(
        skillsRoot,
        entry.projectRoot,
        entry.workflow,
        { yes: opts.yes ?? !entry.requireApproval }
      );
      touchScheduleRun(storageRoot, entry, now);
      results.push({
        id: entry.id,
        workflow: entry.workflow,
        status: status === "ok" ? "ok" : "failed",
      });
    } catch (err: unknown) {
      if (err instanceof ApprovalRequiredError) {
        results.push({
          id: entry.id,
          workflow: entry.workflow,
          status: "skipped",
          reason: err.message,
        });
        continue;
      }
      throw err;
    }
  }

  return results;
}

/** Map CLI `--every 5m` to stored cron `every:5m`. */
export function everyFlagToCron(every: string): string {
  const trimmed = every.trim().toLowerCase();
  if (/^\d+[mh]$/.test(trimmed)) {
    const unit = trimmed.slice(-1);
    const n = trimmed.slice(0, -1);
    return `every:${n}${unit}`;
  }
  if (trimmed.includes(":")) {
    return `daily:${trimmed}`;
  }
  return trimmed;
}
