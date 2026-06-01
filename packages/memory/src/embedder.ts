/**
 * Local, deterministic text embedder — no network, no model file, no API key,
 * fully reproducible (same text → same vector). This keeps semantic memory
 * recall "local-first" and preserves the determinism the eval/replay/trace
 * layers depend on (a provider-backed embedder would add cost + network and
 * break that determinism).
 *
 * It uses the feature-hashing ("hashing trick") technique: token unigrams +
 * bigrams are hashed into a fixed-dimension vector with signed accumulation,
 * then L2-normalized so cosine similarity is meaningful. Quality is modest
 * versus a learned model, but combined with keyword FTS through the
 * {@link HybridRetriever}'s reciprocal-rank fusion it adds real
 * fuzzy/co-occurrence recall the pure-keyword path misses.
 *
 * The {@link Embedder} interface lets a provider-backed embedder be swapped in
 * later without touching any caller.
 */
export interface Embedder {
  /** Stable id recorded on each vector (`embedding_model`) for provenance. */
  readonly id: string;
  /** Output vector length; constant for a given embedder instance. */
  readonly dimension: number;
  embed(text: string): number[];
}

/** FNV-1a 32-bit hash — fast, deterministic, dependency-free. */
function fnv1a(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export class LocalDeterministicEmbedder implements Embedder {
  readonly id: string;
  readonly dimension: number;

  constructor(dimension = 256) {
    this.dimension = dimension;
    this.id = `local-hash-v1-${dimension}`;
  }

  embed(text: string): number[] {
    const vec = new Array<number>(this.dimension).fill(0);
    const tokens = String(text ?? "")
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length > 0);

    const add = (feature: string): void => {
      const idx = fnv1a(feature) % this.dimension;
      // Independent hash for the sign so index and sign aren't correlated.
      const sign = (fnv1a(`§${feature}`) & 1) === 0 ? 1 : -1;
      vec[idx]! += sign;
    };

    for (let i = 0; i < tokens.length; i++) {
      add(tokens[i]!); // unigram
      if (i + 1 < tokens.length) add(`${tokens[i]}_${tokens[i + 1]}`); // bigram
    }

    // L2-normalize so cosine similarity is scale-invariant.
    let norm = 0;
    for (const x of vec) norm += x * x;
    norm = Math.sqrt(norm);
    if (norm === 0) return vec;
    for (let i = 0; i < vec.length; i++) vec[i] = vec[i]! / norm;
    return vec;
  }
}
