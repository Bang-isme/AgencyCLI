import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";
import type { SessionMessage } from "../state/messages.js";
import { sanitizeSessionMessages } from "./sanitize.js";

export interface AgencySession {
  id: string;
  projectRoot: string;
  createdAt: number;
  updatedAt: number;
  messages: SessionMessage[];
}

export function sessionsDir(projectRoot: string): string {
  return join(projectRoot, ".agency", "sessions");
}

export function sessionPath(projectRoot: string, id: string): string {
  return join(sessionsDir(projectRoot), `${id}.json`);
}

export function createSession(projectRoot: string): AgencySession {
  const now = Date.now();
  const id = `sess-${now}`;
  return {
    id,
    projectRoot,
    createdAt: now,
    updatedAt: now,
    messages: [],
  };
}

/**
 * Branch a new session from `source` containing the messages up to and including
 * `upToMessageId` (opencode-style fork). The new session gets a fresh id so the
 * original is left intact on disk; messages are cloned so later edits to one
 * branch don't mutate the other. If the id isn't found, the whole history is
 * copied (a plain duplicate). Pure — the caller switches/saves.
 */
export function forkSession(
  source: AgencySession,
  upToMessageId: string
): AgencySession {
  const idx = source.messages.findIndex((m) => m.id === upToMessageId);
  const slice = idx >= 0 ? source.messages.slice(0, idx + 1) : source.messages;
  const forked = createSession(source.projectRoot);
  return { ...forked, messages: slice.map((m) => ({ ...m })) };
}

export function saveSession(session: AgencySession): void {
  const dir = sessionsDir(session.projectRoot);
  mkdirSync(dir, { recursive: true });
  const updated = { ...session, updatedAt: Date.now() };
  writeFileSync(
    sessionPath(session.projectRoot, session.id),
    JSON.stringify(updated, null, 2),
    "utf8"
  );
}

export function deleteSession(projectRoot: string, id: string): void {
  const path = sessionPath(projectRoot, id);
  if (existsSync(path)) {
    try {
      unlinkSync(path);
    } catch {}
  }
}

export function loadSession(
  projectRoot: string,
  id: string
): AgencySession | null {
  const path = sessionPath(projectRoot, id);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as AgencySession;
  } catch {
    return null;
  }
}

export function listSessionIds(projectRoot: string): string[] {
  const dir = sessionsDir(projectRoot);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.replace(/\.json$/, ""))
    .sort()
    .reverse();
}

export interface SessionSummary {
  id: string;
  messageCount: number;
  updatedAt: number;
  firstUserMessage?: string;
}

export function listSessionSummaries(projectRoot: string): SessionSummary[] {
  const ids = listSessionIds(projectRoot);
  const summaries: SessionSummary[] = [];
  for (const id of ids.slice(0, 20)) {
    const s = loadSession(projectRoot, id);
    if (!s) continue;
    const firstUser = s.messages.find((m) => m.role === "user");
    summaries.push({
      id: s.id,
      messageCount: s.messages.length,
      updatedAt: s.updatedAt,
      firstUserMessage: firstUser?.content?.slice(0, 60),
    });
  }
  return summaries;
}

export function exportSessionMarkdown(session: AgencySession): string {
  const lines = [
    `# Agency session ${session.id}`,
    "",
    `Project: ${session.projectRoot}`,
    `Updated: ${new Date(session.updatedAt).toISOString()}`,
    "",
  ];
  for (const msg of session.messages) {
    const heading =
      msg.role === "user"
        ? "## You"
        : msg.role === "assistant"
          ? "## Assistant"
          : "## System";
    lines.push(heading, "", msg.content, "");
    if (msg.routeSummary) {
      lines.push(`> ${msg.routeSummary}`, "");
    }
  }
  return lines.join("\n");
}

export function exportSessionToFile(session: AgencySession): string {
  const dir = sessionsDir(session.projectRoot);
  mkdirSync(dir, { recursive: true });
  const out = join(dir, `export-${session.id}.md`);
  writeFileSync(out, exportSessionMarkdown(session), "utf8");
  return out;
}

export function loadLatestSession(projectRoot: string): AgencySession {
  const ids = listSessionIds(projectRoot);
  if (ids[0]) {
    const loaded = loadSession(projectRoot, ids[0]);
    if (loaded) {
      return {
        ...loaded,
        messages: sanitizeSessionMessages(loaded.messages),
      };
    }
  }
  const fresh = createSession(projectRoot);
  saveSession(fresh);
  return fresh;
}
