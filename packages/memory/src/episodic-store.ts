import { MemoryStorageBackend } from "./storage-backend.js";
import { Episode } from "./types.js";

export class EpisodicStore {
  private backend: MemoryStorageBackend;

  constructor(backend: MemoryStorageBackend) {
    this.backend = backend;
  }

  public addEpisode(
    sessionId: string,
    goal: string,
    turnIndex: number,
    actionSignature: string,
    content: string,
    metadata: any = {},
    tenantId = "default",
    memoryType = "episodic"
  ): void {
    if (!sessionId || !goal || turnIndex === undefined || !actionSignature || !content) {
      throw new Error("Missing mandatory episode fields.");
    }

    const episode: Episode = {
      tenant_id: tenantId,
      session_id: sessionId,
      goal,
      turn_index: turnIndex,
      action_signature: actionSignature,
      content,
      metadata,
      memory_type: memoryType,
      state: "ACTIVE",
      created_at: Date.now(),
      is_archived: 0,
      confidence_score: 1.0,
      decay_factor: 1.0,
      lamport_timestamp: 0,
    };

    this.backend.addEpisode(episode);
  }

  public getEpisodes(sessionId: string, tenantId = "default"): Episode[] {
    return this.backend.queryEpisodes(sessionId, tenantId);
  }

  public getEpisodesByAction(sessionId: string, actionSignature: string, tenantId = "default"): Episode[] {
    return this.backend.queryEpisodesByAction(sessionId, actionSignature, tenantId);
  }

  /** Most-recent episodes recorded by OTHER sessions (cross-session recency recall). */
  public getRecentAcrossSessions(excludeSessionId: string, limit = 10, tenantId = "default"): Episode[] {
    return this.backend.recentEpisodesAcrossSessions(excludeSessionId, limit, tenantId);
  }

  public searchEpisodesByGoal(goalKeyword: string, tenantId = "default"): Episode[] {
    if (!goalKeyword.trim()) return [];

    try {
      // Direct MATCH query with FTS5
      return this.backend.searchEpisodesFTS(`goal : ${goalKeyword}`, tenantId);
    } catch {
      // Sanitize syntax on parsing error
      const terms = goalKeyword
        .replace(/[^\w\s]/g, " ")
        .trim()
        .split(/\s+/)
        .filter(Boolean)
        .map((t) => `"${t}"`);

      if (terms.length === 0) return [];

      const sanitized = terms.join(" AND ");
      try {
        return this.backend.searchEpisodesFTS(`goal : ${sanitized}`, tenantId);
      } catch {
        return [];
      }
    }
  }

  public deleteEpisodes(sessionId: string, tenantId = "default"): void {
    this.backend.deleteEpisodes(sessionId, tenantId);
  }
}
