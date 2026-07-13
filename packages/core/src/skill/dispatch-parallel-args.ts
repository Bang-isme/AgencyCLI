export interface ParallelTaskInput {
  agentId: string;
  task: string;
  label?: string;
  contextFiles?: string[];
  dispatchId?: string;
}

export type ParseDispatchParallelResult =
  | { ok: true; tasks: ParallelTaskInput[]; batchLabel?: string }
  | { ok: false; error: string; truncated?: boolean };

/** Extract a top-level JSON array substring using bracket matching. */
export function extractJsonArray(text: string, fromIndex = 0): { json: string; truncated: boolean } | null {
  const start = text.indexOf("[", fromIndex);
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let quote: '"' | "'" | null = null;
  let escape = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i]!;
    if (inString) {
      if (escape) {
        escape = false;
        continue;
      }
      if (ch === "\\") {
        escape = true;
        continue;
      }
      if (ch === quote) {
        inString = false;
        quote = null;
      }
      continue;
    }

    if (ch === '"' || ch === "'") {
      inString = true;
      quote = ch;
      continue;
    }
    if (ch === "[") depth++;
    else if (ch === "]") {
      depth--;
      if (depth === 0) return { json: text.slice(start, i + 1), truncated: false };
    }
  }

  return { json: text.slice(start), truncated: true };
}

function normalizeTaskEntry(raw: unknown): ParallelTaskInput | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const agentId = typeof o.agentId === "string" ? o.agentId.trim() : "";
  const task = typeof o.task === "string" ? o.task.trim() : "";
  if (!agentId || !task) return null;
  const entry: ParallelTaskInput = { agentId, task };
  if (typeof o.label === "string" && o.label.trim()) entry.label = o.label.trim();
  if (Array.isArray(o.contextFiles)) {
    entry.contextFiles = o.contextFiles.filter((f): f is string => typeof f === "string");
  }
  if (typeof o.dispatchId === "string" && o.dispatchId.trim()) {
    entry.dispatchId = o.dispatchId.trim();
  }
  return entry;
}

const DISPATCH_PARALLEL_TASKS_ERROR =
  "Error: dispatch_parallel requires a JSON array in `<tasks>` with at least one `{ agentId, task, label? }` entry. " +
  "Keep each task prompt concise (file list + goal, not full implementation). " +
  "For 5+ routes, split into 2–3 batches instead of one giant payload.";

const DISPATCH_PARALLEL_TRUNCATED_ERROR =
  "Error: dispatch_parallel `tasks` JSON was truncated (output token limit). " +
  "Shorten each task to a scoped brief (paths + goals), use `<tasks>[{...}]</tasks>`, and dispatch at most 3–4 tasks per batch.";

/**
 * Parse `tasks` / `batchLabel` for dispatch_parallel from tool-call args or salvage text.
 */
export function parseDispatchParallelTasks(
  args: Record<string, unknown>,
  salvageText?: string
): ParseDispatchParallelResult {
  let batchLabel =
    typeof args.batchLabel === "string" && args.batchLabel.trim()
      ? args.batchLabel.trim()
      : undefined;

  const rawTasks = args.tasks;
  let jsonSource: string | undefined;
  let truncated = false;

  if (Array.isArray(rawTasks)) {
    const tasks = rawTasks
      .map(normalizeTaskEntry)
      .filter((t): t is ParallelTaskInput => t !== null);
    if (tasks.length === 0) {
      return { ok: false, error: DISPATCH_PARALLEL_TASKS_ERROR };
    }
    return { ok: true, tasks, batchLabel };
  }

  if (typeof rawTasks === "string" && rawTasks.trim()) {
    jsonSource = rawTasks.trim();
  }

  if (!jsonSource && salvageText) {
    const tagMatch = /<tasks\b[^>]*>([\s\S]*?)<\/\s*tasks\s*>/i.exec(salvageText);
    if (tagMatch?.[1]) {
      jsonSource = tagMatch[1].trim();
    } else {
      const extracted = extractJsonArray(salvageText);
      if (extracted) {
        jsonSource = extracted.json;
        truncated = extracted.truncated;
      }
    }
    if (!batchLabel) {
      const bl =
        /<batchLabel>([\s\S]*?)<\/\s*batchLabel\s*>/i.exec(salvageText) ??
        /(?:^|\n)\s*Label>\s*([\s\S]*?)\s*Label>/i.exec(salvageText);
      if (bl?.[1]?.trim()) batchLabel = bl[1].trim();
    }
  }

  if (!jsonSource) {
    return { ok: false, error: DISPATCH_PARALLEL_TASKS_ERROR };
  }

  if (truncated) {
    return { ok: false, error: DISPATCH_PARALLEL_TRUNCATED_ERROR, truncated: true };
  }

  try {
    const parsed = JSON.parse(jsonSource);
    if (!Array.isArray(parsed)) {
      return {
        ok: false,
        error:
          "Error: dispatch_parallel `tasks` must be a JSON array, not a single object or string. Wrap entries in `[{...}]` inside `<tasks>`.",
      };
    }
    const tasks = parsed
      .map(normalizeTaskEntry)
      .filter((t): t is ParallelTaskInput => t !== null);
    if (tasks.length === 0) {
      return { ok: false, error: DISPATCH_PARALLEL_TASKS_ERROR };
    }
    return { ok: true, tasks, batchLabel };
  } catch {
    const extracted = extractJsonArray(jsonSource);
    if (extracted?.truncated) {
      return { ok: false, error: DISPATCH_PARALLEL_TRUNCATED_ERROR, truncated: true };
    }
    return {
      ok: false,
      error:
        "Error: dispatch_parallel `tasks` is not valid JSON. Use `<tasks>[{\"agentId\":\"...\",\"task\":\"...\",\"label\":\"...\"}]</tasks>` with properly quoted strings.",
    };
  }
}
