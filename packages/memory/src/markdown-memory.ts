/**
 * Markdown cross-session memory — a curated, human-readable memory layer modeled
 * on the file-based memory an agent like Claude Code keeps across sessions, and
 * deliberately distinct from the automatic SQLite episodic store
 * ({@link EpisodicStore}): that one auto-logs every tool call/reply (noisy,
 * opaque); this one holds a small number of DELIBERATELY-saved, durable facts —
 * user preferences, project decisions, "don't re-investigate" findings — as
 * inspectable, git-friendly markdown.
 *
 * Layout (per project, under `<root>` = `.agency/memory/`):
 *   MEMORY.md          — the index: one line per memory, loaded every session.
 *   <name>.md          — one topic file per memory, with YAML-ish frontmatter:
 *       ---
 *       name: <kebab-slug>            (== the filename, the stable id)
 *       description: <one-liner>      (used for recall relevance)
 *       metadata:
 *         type: user|feedback|project|reference
 *       ---
 *       <body — the fact, markdown; link related memories with [[other-slug]]>
 *
 * Recall keeps the index small enough to always load in full and surfaces topic
 * bodies by relevance within a char budget; `user`/`feedback` memories are always
 * surfaced (they are standing instructions), `project`/`reference` are ranked by
 * the query. Ranking is keyword-overlap by default; pass an {@link Embedder} for
 * semantic (cosine) ranking — the "better than a flat list" path, reusing the
 * same local embedder the SQLite recall uses so no network/key is required.
 *
 * Dependency-free (node:fs/path only) so it stays a leaf with no import cycle.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { Embedder } from "./embedder.js";
import { computeCosineSimilarity } from "./vector-store.js";

export type MemoryType = "user" | "feedback" | "project" | "reference";

const MEMORY_TYPES: ReadonlySet<string> = new Set(["user", "feedback", "project", "reference"]);

/** A single curated memory: one topic file. */
export interface MemoryRecord {
  /** kebab-case slug; also the filename (without .md) and the stable id. */
  name: string;
  /** one-line summary used to judge recall relevance. */
  description: string;
  type: MemoryType;
  /** the fact itself (markdown body). */
  body: string;
}

export interface MemoryRecallOptions {
  /** the current user prompt / query to rank `project`/`reference` memories against. */
  query?: string;
  /** max topic bodies to include in the recall block (excludes always-on user/feedback). */
  limit?: number;
  /** hard cap on the whole recall block size. */
  charBudget?: number;
  /** optional embedder → semantic (cosine) ranking; omitted → keyword overlap. */
  embedder?: Embedder;
}

const INDEX_FILE = "MEMORY.md";
const DEFAULT_RECALL_LIMIT = 6;
const DEFAULT_RECALL_BUDGET = 6000;

/** Normalize an arbitrary string into a safe kebab-case slug usable as a filename. */
export function slugifyMemoryName(raw: string): string {
  const s = raw
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return s || "memory";
}

function coerceType(raw: string | undefined): MemoryType {
  const t = (raw ?? "").trim().toLowerCase();
  return (MEMORY_TYPES.has(t) ? t : "project") as MemoryType;
}

/**
 * Parse a topic file's frontmatter + body. Tolerant by design — a memory file
 * edited by hand (or a model) shouldn't throw; missing fields fall back so the
 * record is still usable. Returns null only when there is no body at all.
 */
export function parseMemoryFile(raw: string, fallbackName: string): MemoryRecord | null {
  let name = fallbackName;
  let description = "";
  let type: MemoryType = "project";
  let body = raw;

  const fm = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (fm) {
    const [, frontmatter, rest] = fm;
    body = (rest ?? "").trim();
    for (const line of (frontmatter ?? "").split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z_]+)\s*:\s*(.*)$/);
      if (!m) continue;
      const key = m[1]!.toLowerCase();
      const val = m[2]!.trim();
      if (key === "name" && val) name = val;
      else if (key === "description") description = val;
      else if (key === "type") type = coerceType(val); // type may sit top-level or under metadata:
    }
  } else {
    body = raw.trim();
  }

  if (!body && !description) return null;
  return { name: name.trim() || fallbackName, description, type, body };
}

/** Serialize a record to topic-file text (frontmatter + body). */
export function serializeMemoryFile(rec: MemoryRecord): string {
  return (
    `---\n` +
    `name: ${rec.name}\n` +
    `description: ${rec.description}\n` +
    `metadata:\n` +
    `  type: ${rec.type}\n` +
    `---\n\n` +
    `${rec.body.trim()}\n`
  );
}

/** Lowercased word set for keyword-overlap scoring. */
function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length > 2)
  );
}

export class MarkdownMemoryStore {
  constructor(private readonly root: string) {}

  private indexPath(): string {
    return join(this.root, INDEX_FILE);
  }

  private filePathFor(name: string): string {
    return join(this.root, `${name}.md`);
  }

  private ensureRoot(): void {
    if (!existsSync(this.root)) mkdirSync(this.root, { recursive: true });
  }

  /** All topic files (the index file itself is excluded), parse-tolerant. */
  list(): MemoryRecord[] {
    if (!existsSync(this.root)) return [];
    const out: MemoryRecord[] = [];
    for (const entry of readdirSync(this.root)) {
      if (!entry.endsWith(".md") || entry === INDEX_FILE) continue;
      const fallback = entry.slice(0, -3);
      try {
        const rec = parseMemoryFile(readFileSync(join(this.root, entry), "utf8"), fallback);
        if (rec) out.push(rec);
      } catch {
        /* unreadable file — skip, never throw on recall */
      }
    }
    return out;
  }

  get(name: string): MemoryRecord | undefined {
    const p = this.filePathFor(name);
    if (!existsSync(p)) return undefined;
    try {
      return parseMemoryFile(readFileSync(p, "utf8"), name) ?? undefined;
    } catch {
      return undefined;
    }
  }

  /** Create or replace a memory (by name) and refresh the index. Returns the slug. */
  upsert(input: { name?: string; description: string; type?: MemoryType; body: string }): string {
    this.ensureRoot();
    const name = slugifyMemoryName(input.name || input.description || "memory");
    const rec: MemoryRecord = {
      name,
      description: input.description.trim(),
      type: coerceType(input.type),
      body: input.body,
    };
    writeFileSync(this.filePathFor(name), serializeMemoryFile(rec), "utf8");
    this.rebuildIndex();
    return name;
  }

  /** Delete a memory and refresh the index. Returns true if a file was removed. */
  remove(name: string): boolean {
    const p = this.filePathFor(name);
    if (!existsSync(p)) return false;
    rmSync(p);
    this.rebuildIndex();
    return true;
  }

  /** Raw index file content ("" if none yet). */
  readIndex(): string {
    const p = this.indexPath();
    return existsSync(p) ? readFileSync(p, "utf8") : "";
  }

  /**
   * Regenerate MEMORY.md from the topic files: a short header + one line per
   * memory grouped by type (user/feedback first — those are standing
   * instructions). Deterministic (sorted) so the file is stable in git.
   */
  rebuildIndex(): void {
    this.ensureRoot();
    const records = this.list().sort((a, b) => a.name.localeCompare(b.name));
    const order: MemoryType[] = ["user", "feedback", "project", "reference"];
    const lines: string[] = [
      "# Agent Memory Index",
      "",
      "> Curated, durable memories saved across sessions. One line per memory —",
      "> detail lives in the linked topic file. Edit freely; it is regenerated on",
      "> every write.",
      "",
    ];
    for (const t of order) {
      const group = records.filter((r) => r.type === t);
      if (group.length === 0) continue;
      lines.push(`## ${t}`);
      for (const r of group) {
        lines.push(`- [${r.description || r.name}](${r.name}.md)`);
      }
      lines.push("");
    }
    if (records.length === 0) lines.push("_(empty)_", "");
    writeFileSync(this.indexPath(), lines.join("\n"), "utf8");
  }

  /**
   * Build the recall block injected into the prompt: the index (always) plus the
   * most relevant topic bodies within `charBudget`. `user`/`feedback` memories
   * are always surfaced (standing instructions); `project`/`reference` are ranked
   * by the query — semantically when an embedder is supplied, else by keyword
   * overlap. Returns "" when there is nothing saved. Never throws.
   */
  recall(opts: MemoryRecallOptions = {}): string {
    let records: MemoryRecord[];
    try {
      records = this.list();
    } catch {
      return "";
    }
    if (records.length === 0) return "";

    const limit = opts.limit ?? DEFAULT_RECALL_LIMIT;
    const budget = opts.charBudget ?? DEFAULT_RECALL_BUDGET;
    const query = (opts.query ?? "").trim();

    const standing = records.filter((r) => r.type === "user" || r.type === "feedback");
    const rankable = records.filter((r) => r.type === "project" || r.type === "reference");

    // Rank the non-standing memories by relevance to the query.
    let ranked: MemoryRecord[];
    if (query && opts.embedder) {
      const qv = opts.embedder.embed(query);
      ranked = rankable
        .map((r) => ({
          r,
          score: safeCosine(opts.embedder!, qv, `${r.description}\n${r.body}`),
        }))
        .sort((a, b) => b.score - a.score)
        .map((x) => x.r);
    } else if (query) {
      const qTokens = tokenize(query);
      ranked = rankable
        .map((r) => {
          const rTokens = tokenize(`${r.description} ${r.body}`);
          let overlap = 0;
          for (const w of qTokens) if (rTokens.has(w)) overlap++;
          return { r, score: overlap };
        })
        .sort((a, b) => b.score - a.score)
        .map((x) => x.r);
    } else {
      ranked = rankable;
    }

    const selected = [...standing, ...ranked.slice(0, Math.max(0, limit))];

    const header =
      "The following are your curated, durable memories from past sessions " +
      "(.agency/memory). Treat `user` and `feedback` memories as STANDING instructions.";
    const parts: string[] = [header, "", "## Memory index", this.indexSummary(records)];

    let used = parts.join("\n").length;
    const bodies: string[] = ["", "## Relevant memories"];
    for (const r of selected) {
      const block = `### ${r.description || r.name} (${r.type})\n${r.body.trim()}`;
      if (used + block.length > budget && bodies.length > 2) break;
      bodies.push(block, "");
      used += block.length;
    }
    if (bodies.length > 2) parts.push(...bodies);

    return parts.join("\n").trim();
  }

  /** Compact one-line-per-memory summary (used inside the recall block). */
  private indexSummary(records: MemoryRecord[]): string {
    return records
      .slice()
      .sort((a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name))
      .map((r) => `- (${r.type}) ${r.name}: ${r.description}`)
      .join("\n");
  }
}

function safeCosine(embedder: Embedder, queryVec: number[], text: string): number {
  try {
    return computeCosineSimilarity(queryVec, embedder.embed(text));
  } catch {
    return 0;
  }
}
