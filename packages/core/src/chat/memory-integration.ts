import { getDb, EpisodicStore } from "@agency/memory";
import { EventBus } from "../events/event-bus.js";

/**
 * Maximum characters of formatted memory injected into the system prompt. Each
 * episode is already snippet-capped; this bounds the *total* recall block so a
 * project with many recorded episodes can never bloat the prompt (a long-context
 * safety valve — the conversation history itself is bounded separately by
 * compaction).
 */
const RECALL_CHAR_BUDGET = 6000;

/**
 * Loads relevant historical episodes matching the current userPrompt via FTS5
 * along with the most recent chronological episodes from OTHER sessions, both
 * via the typed store API (no raw SQL), bounded by {@link RECALL_CHAR_BUDGET}.
 */
export async function loadHistoricalMemories(
  projectRoot: string,
  userPrompt: string,
  currentSessionId: string
): Promise<string> {
  try {
    const db = getDb(projectRoot);
    const store = new EpisodicStore(db);

    // 1. Relevant episodes matching the prompt's keywords (FTS5), past sessions only.
    const ftsMatches = store.searchEpisodesByGoal(userPrompt);

    // 2. Most-recent episodes from OTHER sessions (typed recency recall — replaces
    //    the previous raw `(db as any).db` SQL that bypassed the store).
    const recentEpisodes = store.getRecentAcrossSessions(currentSessionId, 10);

    const formattedEpisodes: string[] = [];
    const seen = new Set<number>();
    let usedChars = 0;
    let budgetHit = false;

    const formatEpisode = (ep: any) => {
      if (budgetHit || !ep.id || seen.has(ep.id)) return;
      seen.add(ep.id);

      const dateStr = new Date(ep.created_at).toISOString().split("T")[0];
      const goalStr = ep.goal.length > 80 ? ep.goal.slice(0, 80) + "..." : ep.goal;
      const contentSnippet = ep.content.length > 150 ? ep.content.slice(0, 150) + "..." : ep.content;

      const line = `- [Date: ${dateStr}, Session: ${ep.session_id}, Turn: ${ep.turn_index}, Goal: "${goalStr}", Action: ${ep.action_signature}]\n  Content: ${contentSnippet.replace(/\s+/g, " ").trim()}`;

      // Stop before exceeding the recall budget (keep what we have; never drop
      // the leading line mid-way once at least one episode is included).
      if (usedChars + line.length > RECALL_CHAR_BUDGET && formattedEpisodes.length > 0) {
        budgetHit = true;
        return;
      }
      formattedEpisodes.push(line);
      usedChars += line.length;
    };

    // Ingest FTS matches first (highest relevance), filtering out the current session.
    ftsMatches
      .filter((m: any) => m.session_id !== currentSessionId)
      .slice(0, 10)
      .forEach(formatEpisode);

    // Then chronological recency episodes.
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
