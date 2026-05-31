import { getDb, EpisodicStore } from "@agency/memory";
import { EventBus } from "../events/event-bus.js";

/**
 * Loads relevant historical episodes matching the current userPrompt via FTS5
 * along with the 10 most recent chronological episodes from past sessions.
 */
export async function loadHistoricalMemories(
  projectRoot: string,
  userPrompt: string,
  currentSessionId: string
): Promise<string> {
  try {
    const db = getDb(projectRoot);
    const store = new EpisodicStore(db);

    // 1. Fetch relevant episodes matching the current userPrompt's keywords using FTS5 search
    const ftsMatches = store.searchEpisodesByGoal(userPrompt);

    // 2. Fetch the 10 most recent chronological episodes from past sessions
    const rawDb = (db as any).db;
    let recentEpisodes: any[] = [];
    if (rawDb && typeof rawDb.prepare === "function") {
      try {
        recentEpisodes = rawDb.prepare(`
          SELECT * FROM episodes
          WHERE session_id != ?
          ORDER BY created_at DESC
          LIMIT 10
        `).all(currentSessionId) as any[];
      } catch (dbErr) {
        // fail-safe
      }
    }

    const formattedEpisodes: string[] = [];
    const seen = new Set<number>();

    const formatEpisode = (ep: any) => {
      if (!ep.id || seen.has(ep.id)) return;
      seen.add(ep.id);

      const dateStr = new Date(ep.created_at).toISOString().split("T")[0];
      const goalStr = ep.goal.length > 80 ? ep.goal.slice(0, 80) + "..." : ep.goal;
      const contentSnippet = ep.content.length > 150 ? ep.content.slice(0, 150) + "..." : ep.content;

      formattedEpisodes.push(
        `- [Date: ${dateStr}, Session: ${ep.session_id}, Turn: ${ep.turn_index}, Goal: "${goalStr}", Action: ${ep.action_signature}]\n  Content: ${contentSnippet.replace(/\s+/g, " ").trim()}`
      );
    };

    // Ingest FTS matches first, filtering out the current session
    ftsMatches
      .filter((m: any) => m.session_id !== currentSessionId)
      .slice(0, 10)
      .forEach(formatEpisode);

    // Ingest chronological recency episodes next
    recentEpisodes.forEach(formatEpisode);

    if (formattedEpisodes.length === 0) {
      return "";
    }

    return [
      "The following are relevant past activities and actions recorded in the persistent SQLite memory from past sessions:",
      ...formattedEpisodes
    ].join("\n");
  } catch (err) {
    return "";
  }
}

/**
 * Idempotently and safely adds a turn/action episode to the persistent SQLite database.
 * Failures are silenced to prevent breaking main chat turn execution.
 */
export function safeAddEpisode(
  projectRoot: string,
  sessionId: string,
  goal: string,
  turnIndex: number,
  actionSignature: string,
  content: string
): void {
  try {
    const db = getDb(projectRoot);
    const store = new EpisodicStore(db);
    store.addEpisode(
      sessionId,
      goal,
      turnIndex,
      actionSignature,
      content,
      { created_at: Date.now() }
    );
  } catch (err) {
    // The write failed (disk full, corrupt DB, ENFILE, schema drift, ...).
    // Swallowing it keeps the chat turn alive — persisting a memory must never
    // crash the conversation — but a silently-dropped episode means the agent's
    // persistent history degrades with zero signal. Surface it best-effort so
    // the loss is observable, mirroring loadCheckpoint's corrupt-checkpoint
    // warning. The publish itself is wrapped so telemetry can never re-break the
    // path we are protecting.
    try {
      void EventBus.getInstance().publish("system:warning", {
        message: `⚠ Failed to persist memory episode (session ${sessionId}, turn ${turnIndex}) — chat continues but this turn was not recorded: ${(err as Error)?.message ?? String(err)}`,
      });
    } catch {
      /* observability is best-effort */
    }
  }
}
