import { MemoryStorageBackend } from "./storage-backend.js";
import { VectorEntry, QueryOptions, Explanation } from "./types.js";

let nativeSimilarityKernel: ((a: number[], b: number[]) => number) | null = null;

export async function loadNativeKernel(path: string): Promise<void> {
  try {
    const module = await import(path);
    if (typeof module.similarity === "function") {
      nativeSimilarityKernel = module.similarity;
    }
  } catch {
    // Fail silently to align with error handling guidelines
  }
}

export function computeCosineSimilarity(a: number[], b: number[]): number {
  if (nativeSimilarityKernel) {
    try {
      return nativeSimilarityKernel(a, b);
    } catch {
      // Fallback if native kernel fails
    }
  }

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;
  const len = Math.min(a.length, b.length);

  for (let i = 0; i < len; i++) {
    const valA = a[i]!;
    const valB = b[i]!;
    dotProduct += valA * valB;
    normA += valA * valA;
    normB += valB * valB;
  }

  if (normA === 0 || normB === 0) {
    return 0.0;
  }

  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

export class VectorStore {
  private backend: MemoryStorageBackend;
  private dimensionLimit: number | null = null;

  constructor(backend: MemoryStorageBackend) {
    this.backend = backend;
    this.initializeDimensionLimit();
  }

  private initializeDimensionLimit(): void {
    const existing = this.backend.queryVectors();
    if (existing.length > 0 && existing[0]?.vector) {
      this.dimensionLimit = existing[0].vector.length;
    }
  }

  public insert(entry: VectorEntry): void {
    if (this.dimensionLimit === null) {
      this.dimensionLimit = entry.vector.length;
    } else if (entry.vector.length !== this.dimensionLimit) {
      throw new Error(
        `Dimension mismatch. Expected vector of dimension ${this.dimensionLimit}, received ${entry.vector.length}`
      );
    }

    this.backend.insertVector(entry);
  }

  public deleteVector(id: string, tenantId = "default"): void {
    this.backend.deleteVector(id, tenantId);
  }

  public search(
    queryVector: number[],
    options: QueryOptions = {}
  ): { id: string; content: string; similarity: number; metadata: any; explanation: Explanation }[] {
    const tenantId = options.tenant_id ?? "default";
    const threshold = options.similarityThreshold ?? -1.0;
    const limit = options.limit ?? 10;
    const offset = options.offset ?? 0;

    if (this.dimensionLimit !== null && queryVector.length !== this.dimensionLimit) {
      throw new Error(
        `Query dimension mismatch. Expected vector of dimension ${this.dimensionLimit}, received ${queryVector.length}`
      );
    }

    const allEntries = this.backend.queryVectors(tenantId);
    const results: {
      id: string;
      content: string;
      similarity: number;
      metadata: any;
      explanation: Explanation;
    }[] = [];

    for (const entry of allEntries) {
      const sim = computeCosineSimilarity(queryVector, entry.vector);
      if (sim >= threshold) {
        const explanation: Explanation = {
          base_score: sim,
          recency_boost: 0,
          dependency_boost: 0,
          reranker_shift: 0,
          final_score: sim,
          reason: `Cosine similarity matching score of ${sim.toFixed(4)}.`,
        };

        results.push({
          id: entry.id,
          content: entry.content,
          similarity: sim,
          metadata: entry.metadata,
          explanation,
        });
      }
    }

    // Sort descending by similarity score, stable tie-break by ID
    results.sort((a, b) => {
      if (Math.abs(b.similarity - a.similarity) > 1e-9) {
        return b.similarity - a.similarity;
      }
      return String(a.id).localeCompare(String(b.id));
    });

    return results.slice(offset, offset + limit);
  }
}
