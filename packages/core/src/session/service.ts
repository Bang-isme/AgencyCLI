import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";

export type MessageRole = "user" | "assistant" | "system";

export interface MessagePresentation {
  chips?: any[];
  suggestions?: string[];
  cacheHint?: string;
}

export interface SessionMessage {
  id: string;
  role: MessageRole;
  content: string;
  routeSummary?: string;
  presentation?: MessagePresentation;
  streaming?: boolean;
  thought?: string;
  thoughtDurationMs?: number;
  timestamp: number;
}

export interface AgencySession {
  id: string;
  projectRoot: string;
  createdAt: number;
  updatedAt: number;
  messages: SessionMessage[];
}

export interface SessionSummary {
  id: string;
  messageCount: number;
  updatedAt: number;
  firstUserMessage?: string;
}

const HELP_MARKERS = [
  "Slash commands:",
  "Shortcuts:",
  "Ctrl+P palette",
  "/doctor",
  "/connect",
  "agency config init",
];

function isHelpDump(content: string): boolean {
  const hits = HELP_MARKERS.filter((m) => content.includes(m)).length;
  return hits >= 2 || (content.includes("Slash commands:") && content.length > 80);
}

export class SessionService {
  static sessionsDir(projectRoot: string): string {
    return join(projectRoot, ".agency", "sessions");
  }

  static sessionPath(projectRoot: string, id: string): string {
    return join(this.sessionsDir(projectRoot), `${id}.json`);
  }

  /** Creates a new session and persists to disk */
  static createSession(projectRoot: string): AgencySession {
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

  /** Branch a new session from `source` containing messages up to `upToMessageId` */
  static forkSession(source: AgencySession, upToMessageId: string): AgencySession {
    const idx = source.messages.findIndex((m) => m.id === upToMessageId);
    const slice = idx >= 0 ? source.messages.slice(0, idx + 1) : source.messages;
    const forked = this.createSession(source.projectRoot);
    return { ...forked, messages: slice.map((m) => ({ ...m })) };
  }

  /** Saves session JSON to disk */
  static saveSession(session: AgencySession): void {
    const dir = this.sessionsDir(session.projectRoot);
    mkdirSync(dir, { recursive: true });
    const updated = { ...session, updatedAt: Date.now() };
    writeFileSync(
      this.sessionPath(session.projectRoot, session.id),
      JSON.stringify(updated, null, 2),
      "utf8"
    );
  }

  /** Deletes session file from disk */
  static deleteSession(projectRoot: string, id: string): void {
    const path = this.sessionPath(projectRoot, id);
    if (existsSync(path)) {
      try {
        unlinkSync(path);
      } catch {}
    }
  }

  /** Loads and repairs session history, preventing orphan tool loops */
  static loadSession(projectRoot: string, id: string): AgencySession | null {
    const path = this.sessionPath(projectRoot, id);
    if (!existsSync(path)) return null;
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as AgencySession;
      return {
        ...parsed,
        messages: this.sanitizeAndRepairSession(parsed.messages || []),
      };
    } catch {
      return null;
    }
  }

  /** Lists all session IDs sorted newest first */
  static listSessionIds(projectRoot: string): string[] {
    const dir = this.sessionsDir(projectRoot);
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => f.replace(/\.json$/, ""))
      .sort()
      .reverse();
  }

  /** Lists all session summaries ordered by updatedAt desc */
  static listSessionSummaries(projectRoot: string): SessionSummary[] {
    const ids = this.listSessionIds(projectRoot);
    const summaries: SessionSummary[] = [];
    for (const id of ids.slice(0, 20)) {
      const s = this.loadSession(projectRoot, id);
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

  /** Formats session transcript as Markdown */
  static exportSessionMarkdown(session: AgencySession): string {
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

  /** Exports session transcript to Markdown file */
  static exportSessionToFile(session: AgencySession): string {
    const dir = this.sessionsDir(session.projectRoot);
    mkdirSync(dir, { recursive: true });
    const out = join(dir, `export-${session.id}.md`);
    writeFileSync(out, this.exportSessionMarkdown(session), "utf8");
    return out;
  }

  /** Loads the most recent session or creates a fresh one */
  static loadLatestSession(projectRoot: string): AgencySession {
    const ids = this.listSessionIds(projectRoot);
    if (ids[0]) {
      const loaded = this.loadSession(projectRoot, ids[0]);
      if (loaded) {
        return loaded;
      }
    }
    const fresh = this.createSession(projectRoot);
    this.saveSession(fresh);
    return fresh;
  }

  /** Core repair engine: closes unclosed tags, injects synthetic tool responses for pending calls */
  static sanitizeAndRepairSession(messages: SessionMessage[]): SessionMessage[] {
    const cleaned = messages
      .filter((m) => {
        if (m.role !== "system") return true;
        if (isHelpDump(m.content)) return false;
        return true;
      })
      .map((m) => {
        let content = m.content;
        // Fix unclosed tool call XML tags
        const openTags = (content.match(/<tool_call\b/g) || []).length;
        const closeTags = (content.match(/<\/tool_call>/g) || []).length;
        if (openTags > closeTags) {
          content = content + "</tool_call>".repeat(openTags - closeTags);
        }
        if (content !== m.content) {
          return { ...m, content };
        }
        return m;
      });

    const repaired: SessionMessage[] = [];
    for (let i = 0; i < cleaned.length; i++) {
      const current = cleaned[i]!;
      repaired.push(current);

      if (current.role === "assistant" && current.content.includes("<tool_call")) {
        const next = cleaned[i + 1];
        const hasResponse =
          next &&
          (next.content.includes("<tool_response") ||
            next.content.includes("tool_result") ||
            next.role === "system");
        if (!hasResponse) {
          repaired.push({
            id: `repair-${Date.now()}-${i}`,
            role: "system",
            content: "[SESSION RESUMED: Tool execution interrupted]",
            timestamp: Date.now(),
          });
        }
      }
    }

    return repaired;
  }
}
