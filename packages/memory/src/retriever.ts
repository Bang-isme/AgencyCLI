import { EpisodicStore } from "./episodic-store.js";
import { VectorStore } from "./vector-store.js";
import { GraphStore } from "./graph-store.js";
import {
  QueryOptions,
  ExecutionCtx,
  RetrievalProfile,
  Explanation,
} from "./types.js";

export class FederatedMemoryManager {
  private backends = new Map<string, { vectorStore: VectorStore; episodicStore: EpisodicStore }>();

  public registerStore(scopeId: string, vectorStore: VectorStore, episodicStore: EpisodicStore): void {
    this.backends.set(scopeId, { vectorStore, episodicStore });
  }

  public queryFederated(
    queryVector: number[],
    matchQuery: string,
    options: QueryOptions = {}
  ): { scopeId: string; results: any[] }[] {
    const outputs: { scopeId: string; results: any[] }[] = [];

    for (const [scopeId, store] of this.backends.entries()) {
      try {
        const vecMatches = store.vectorStore.search(queryVector, options);
        const ftsMatches = store.episodicStore.searchEpisodesByGoal(matchQuery, options.tenant_id);

        outputs.push({
          scopeId,
          results: [...vecMatches, ...ftsMatches],
        });
      } catch {
        // Degrade gracefully on sub-store failures
      }
    }

    return outputs;
  }
}

export class HybridRetriever {
  private episodicStore: EpisodicStore;
  private vectorStore: VectorStore;
  private _graphStore: GraphStore;

  constructor(episodicStore: EpisodicStore, vectorStore: VectorStore, graphStore: GraphStore) {
    this.episodicStore = episodicStore;
    this.vectorStore = vectorStore;
    this._graphStore = graphStore;
  }

  public getGraphStore(): GraphStore {
    return this._graphStore;
  }

  /**
   * Main Hybrid Search Cascades: Cache -> Episodic FTS -> Semantic Vector -> Graph -> Archive
   */
  public retrieve(
    queryVector: number[],
    matchQuery: string,
    options: QueryOptions = {},
    executionCtx: ExecutionCtx = {},
    profile?: RetrievalProfile,
    rerankCallback?: (results: any[]) => any[]
  ): any[] {
    const tenantId = options.tenant_id ?? "default";
    const threshold = options.similarityThreshold ?? 0.0;
    const limit = options.limit ?? 10;
    const maxTokens = options.maxTokens ?? 2000;

    // Phase 1: Semantic Vector search
    const vectorMatches = this.vectorStore.search(queryVector, {
      ...options,
      similarityThreshold: threshold,
    });

    // Phase 2: Episodic FTS search
    const ftsMatches = this.episodicStore.searchEpisodesByGoal(matchQuery, tenantId);

    // Rank vector matches (1-based)
    const vectorRankMap = new Map<string, number>();
    vectorMatches.forEach((m, idx) => {
      vectorRankMap.set(m.id, idx + 1);
    });

    // Rank FTS matches (1-based)
    const ftsRankMap = new Map<string, number>();
    ftsMatches.forEach((m, idx) => {
      const matchId = m.id !== undefined ? String(m.id) : `fts-${idx}`;
      ftsRankMap.set(matchId, idx + 1);
    });

    const allIds = new Set([...vectorRankMap.keys(), ...ftsRankMap.keys()]);
    const merged = new Map<string, any>();
    const k = 60; // Configurable RRF rank constant

    for (const id of allIds) {
      const vectorRank = vectorRankMap.get(id);
      const ftsRank = ftsRankMap.get(id);

      const rrfScoreVec = vectorRank ? 1 / (k + vectorRank) : 0;
      const rrfScoreFts = ftsRank ? 1 / (k + ftsRank) : 0;
      const finalRrfScore = rrfScoreVec + rrfScoreFts;

      const vecMatch = vectorMatches.find((m) => m.id === id);
      const ftsMatch = ftsMatches.find((m) => (m.id !== undefined ? String(m.id) : "") === id);

      const content = vecMatch?.content ?? ftsMatch?.content ?? "";
      const metadata = vecMatch?.metadata ?? ftsMatch?.metadata ?? {};
      const type = vecMatch ? "semantic" : "episodic";

      const explanation: Explanation = {
        base_score: finalRrfScore,
        recency_boost: 0,
        dependency_boost: 0,
        reranker_shift: 0,
        final_score: finalRrfScore,
        reason: `RRF Score: ${finalRrfScore.toFixed(6)} (Vector rank: ${vectorRank ?? "none"}, FTS rank: ${ftsRank ?? "none"}).`,
      };

      merged.set(id, {
        id,
        content,
        score: finalRrfScore,
        metadata,
        type,
        explanation,
        // Expose the richest matched source record (vector entry or episode) so
        // callers can format domain-specific fields without this generic
        // retriever having to know about them. Vector hits win when both exist.
        source: vecMatch ?? ftsMatch,
      });
    }

    let results = Array.from(merged.values());

    // Phase 3: Apply boosting based on Execution context & Retrieval Profile
    for (const item of results) {
      this.applyBoosting(item, executionCtx, profile);
    }

    // Sort descending by updated final score, stable tie-break by record ID
    results.sort((a, b) => {
      if (Math.abs(b.score - a.score) > 1e-9) {
        return b.score - a.score;
      }
      return String(a.id).localeCompare(String(b.id));
    });

    // Phase 4: Apply optional custom Reranker callback
    if (rerankCallback) {
      results = rerankCallback(results);
    }

    // Phase 5: Token budget packing (Adaptive Degradation)
    return this.packResults(results, limit, maxTokens);
  }

  private applyBoosting(item: any, executionCtx: ExecutionCtx, profile?: RetrievalProfile): void {
    let boost = 0.0;
    const reasons: string[] = [];

    // Recency boosting (based on metadata created_at if available)
    if (item.metadata?.created_at) {
      const ageHours = (Date.now() - item.metadata.created_at) / (1000 * 60 * 60);
      const recencyBoost = 0.1 / (1.0 + ageHours * 0.05); // decay boost over time
      boost += recencyBoost;
      item.explanation.recency_boost = recencyBoost;
      reasons.push(`Recency boost of +${recencyBoost.toFixed(4)} applied (Age: ${ageHours.toFixed(1)} hrs).`);
    }

    // Active task boosting
    if (executionCtx.activeTaskId && item.content.includes(executionCtx.activeTaskId)) {
      boost += 0.20;
      item.explanation.dependency_boost += 0.20;
      reasons.push("Active Task ID boost +0.20.");
    }

    // Edited files boosting
    if (executionCtx.editedFiles && item.metadata?.file_path) {
      const fileMatch = executionCtx.editedFiles.some((f) => item.metadata.file_path.includes(f));
      if (fileMatch) {
        boost += 0.20;
        item.explanation.dependency_boost += 0.20;
        reasons.push("Edited files proximity boost +0.20.");
      }
    }

    // Planner profile priority adjustments
    if (profile === "planner" && item.type === "episodic") {
      boost += 0.15;
      item.explanation.reranker_shift += 0.15;
      reasons.push("Planner profile episodic boost +0.15.");
    }

    item.score += boost;
    item.explanation.final_score = item.score;
    if (reasons.length > 0) {
      item.explanation.reason += " " + reasons.join(" ");
    }
  }

  private packResults(results: any[], limit: number, maxTokens: number): any[] {
    const packed: any[] = [];
    let currentTokens = 0;

    for (const item of results) {
      if (packed.length >= limit) break;

      // Estimate tokens by word count (4 chars = 1 token estimate)
      const estimatedTokens = Math.ceil(item.content.length / 4);

      if (currentTokens + estimatedTokens <= maxTokens) {
        packed.push(item);
        currentTokens += estimatedTokens;
      } else {
        // Adaptive degradation fallback: compress to summary template
        const compressedSummary = `[Summary: ${item.content.slice(0, 100)}...]`;
        const summaryTokens = Math.ceil(compressedSummary.length / 4);

        if (currentTokens + summaryTokens <= maxTokens) {
          packed.push({
            ...item,
            content: compressedSummary,
            degraded: true,
          });
          currentTokens += summaryTokens;
        }
      }
    }

    return packed;
  }
}
