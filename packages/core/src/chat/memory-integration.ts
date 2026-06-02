import { createHash } from "node:crypto";
import {
  getDb,
  EpisodicStore,
  VectorStore,
  GraphStore,
  HybridRetriever,
  LocalDeterministicEmbedder,
  MarkdownMemoryStore,
  type Embedder,
} from "@agency/memory";
import { EventBus } from "../events/event-bus.js";
import { getRuntimeFlags } from "../runtime/flags.js";

/**
 * Maximum characters of formatted memory injected into the system prompt. Each
 * episode is already snippet-capped; this bounds the *total* recall block so a
 * project with many recorded episodes can never bloat the prompt (a long-context
 * safety valve — the conversation history itself is bounded separately by
 * compaction).
 */
const RECALL_CHAR_BUDGET = 6000;

/**
 * One process-wide local deterministic embedder (no network/key/model file).
 * Lazily built so the cost is paid only when semantic recall is enabled. Behind
 * the {@link Embedder} interface so a provider-backed embedder can be swapped in
 * later. See {@link LocalDeterministicEmbedder}.
 */
let embedder: Embedder | undefined;
function getEmbedder(): Embedder {
  if (!embedder) embedder = new LocalDeterministicEmbedder();
  return embedder;
}

/** A stable, upsert-safe vector id for an episode (content hash keeps distinct calls distinct). */
function vectorIdFor(sessionId: string, turnIndex: number, actionSignature: string, content: string): string {
  const h = createHash("sha1").update(content).digest("hex").slice(0, 8);
  return `${sessionId}:${turnIndex}:${actionSignature}:${h}`;
}

/** The fields the recall block formats — present top-level on an Episode, in `metadata` on a vector hit. */
interface EpisodeLike {
  id?: number | string;
  session_id?: string;
  turn_index?: number;
  action_signature?: string;
  goal?: string;
  content?: string;
  created_at?: number;
  metadata?: any;
}

function displayFields(rec: EpisodeLike) {
  const meta = rec.metadata ?? {};
  return {
    session_id: rec.session_id ?? meta.session_id ?? "",
    turn_index: rec.turn_index ?? meta.turn_index ?? 0,
    action_signature: rec.action_signature ?? meta.action_signature ?? "",
    goal: rec.goal ?? meta.goal ?? "",
    content: rec.content ?? "",
    created_at: rec.created_at ?? meta.created_at ?? Date.now(),
  };
}

/**
 * Loads relevant historical episodes from past sessions, bounded by
 * {@link RECALL_CHAR_BUDGET}. With `memorySemantic` off (legacy) this is keyword
 * FTS + chronological recency via the typed store API. With it on, relevance
 * comes from the {@link HybridRetriever} (semantic vector + FTS reciprocal-rank
 * fusion + recency/boosting), and recency is still appended so an unrelated
 * prompt still surfaces recent context. Never throws.
 */
export async function loadHistoricalMemories(
  projectRoot: string,
  userPrompt: string,
  currentSessionId: string
): Promise<string> {
  // Curated markdown memory (flag-gated). Prepended ahead of the auto-episode
  // recall because it is higher-signal — deliberately-saved facts and standing
  // user/feedback instructions vs the noisy per-tool episode log. Best-effort.
  const fileMemoryBlock = loadFileMemoryBlock(projectRoot, userPrompt);

  const episodeBlock = await loadEpisodeRecallBlock(projectRoot, userPrompt, currentSessionId);

  return [fileMemoryBlock, episodeBlock].filter(Boolean).join("\n\n");
}

/** The curated markdown-memory recall block ("" when off / empty / on error). */
function loadFileMemoryBlock(projectRoot: string, userPrompt: string): string {
  if (!getRuntimeFlags().fileMemory) return "";
  try {
    const store = MarkdownMemoryStore.forProject(projectRoot);
    return store.recall({
      query: userPrompt,
      // Reuse the same local embedder the SQLite recall uses when semantic recall
      // is on → semantic ranking of memories; otherwise keyword overlap.
      embedder: getRuntimeFlags().memorySemantic ? getEmbedder() : undefined,
    });
  } catch {
    return "";
  }
}

/**
 * The automatic SQLite episodic recall block (the legacy behaviour, unchanged).
 * Returns "" when there is nothing to recall. Never throws.
 */
async function loadEpisodeRecallBlock(
  projectRoot: string,
  userPrompt: string,
  currentSessionId: string
): Promise<string> {
  try {
    const db = getDb(projectRoot);
    const store = new EpisodicStore(db);
    const semantic = getRuntimeFlags().memorySemantic;

    // Most-recent episodes from OTHER sessions (typed recency recall — shared by
    // both paths; replaces the previous raw `(db as any).db` SQL).
    const recentEpisodes = store.getRecentAcrossSessions(currentSessionId, 10);

    const formattedEpisodes: string[] = [];
    const seen = new Set<string>();
    let usedChars = 0;
    let budgetHit = false;

    const formatRecord = (rec: EpisodeLike): void => {
      if (budgetHit) return;
      const f = displayFields(rec);
      if (!f.session_id || f.session_id === currentSessionId) return; // past sessions only
      const key = `${f.session_id}:${f.turn_index}:${f.action_signature}`;
      if (seen.has(key)) return;
      seen.add(key);

      const dateStr = new Date(f.created_at).toISOString().split("T")[0];
      const goalStr = f.goal.length > 80 ? f.goal.slice(0, 80) + "..." : f.goal;
      const contentSnippet = f.content.length > 150 ? f.content.slice(0, 150) + "..." : f.content;
      const line = `- [Date: ${dateStr}, Session: ${f.session_id}, Turn: ${f.turn_index}, Goal: "${goalStr}", Action: ${f.action_signature}]\n  Content: ${contentSnippet.replace(/\s+/g, " ").trim()}`;

      if (usedChars + line.length > RECALL_CHAR_BUDGET && formattedEpisodes.length > 0) {
        budgetHit = true;
        return;
      }
      formattedEpisodes.push(line);
      usedChars += line.length;
    };

    // 1. Relevance: HybridRetriever (semantic) or plain FTS (legacy).
    if (semantic) {
      try {
        const retriever = new HybridRetriever(store, new VectorStore(db), new GraphStore(db));
        const queryVector = getEmbedder().embed(userPrompt);
        const ranked = retriever.retrieve(queryVector, userPrompt, { limit: 12, maxTokens: 4000 });
        for (const r of ranked) {
          if (r.source) formatRecord(r.source as EpisodeLike);
        }
      } catch {
        // Semantic recall is purely additive — on any failure (e.g. a dimension
        // mismatch from a foreign vector) fall back to the keyword path below.
        store
          .searchEpisodesByGoal(userPrompt)
          .filter((m) => m.session_id !== currentSessionId)
          .slice(0, 10)
          .forEach(formatRecord);
      }
    } else {
      store
        .searchEpisodesByGoal(userPrompt)
        .filter((m) => m.session_id !== currentSessionId)
        .slice(0, 10)
        .forEach(formatRecord);
    }

    // 2. Chronological recency (newest from other sessions), regardless of match.
    recentEpisodes.forEach(formatRecord);

    if (formattedEpisodes.length === 0) {
      return "";
    }

    return [
      "The following are relevant past activities and actions recorded in the persistent SQLite memory from past sessions:",
      ...formattedEpisodes,
    ].join("\n");
  } catch (err) {
    return "";
  }
}

/**
 * Idempotently and safely adds a turn/action episode to the persistent SQLite
 * database. When `memorySemantic` is on, also writes a local-embedding vector so
 * the episode is recallable by semantic similarity (best-effort; a vector
 * failure never blocks the episode write). Failures are surfaced as a
 * `system:warning` but never thrown, so a memory write can't break a chat turn.
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

    // Semantic index: embed the goal + content so similarity recall can find
    // this episode later. Best-effort and isolated — a vector failure (e.g. a
    // dimension mismatch) must not lose the episode we just persisted.
    if (getRuntimeFlags().memorySemantic) {
      try {
        const emb = getEmbedder();
        new VectorStore(db).insert({
          id: vectorIdFor(sessionId, turnIndex, actionSignature, content),
          tenant_id: "default",
          session_id: sessionId,
          memory_type: "episodic",
          state: "ACTIVE",
          vector: emb.embed(`${goal}\n${content}`),
          content,
          metadata: { session_id: sessionId, turn_index: turnIndex, action_signature: actionSignature, goal, created_at: Date.now() },
          embedding_model: emb.id,
          embedding_dimension: emb.dimension,
          lamport_timestamp: 0,
        });
      } catch {
        // Vector indexing is an enhancement, not a guarantee — swallow.
      }
    }
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
