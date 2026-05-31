

export interface ChunkingOptions {
  chunkSize?: number;
  chunkOverlap?: number;
  mergeThreshold?: number; // Similarity threshold to merge small adjacent chunks
  enableAstSplitting?: boolean;
}

export class IngestionPipeline {
  // Simple regex-based secret detection patterns to prevent ingestion leaks
  private static SECRET_PATTERNS = [
    /AIza[0-9A-Za-z-_]{35}/, // Google API key
    /xox[bapr]-[0-9A-Za-z-]{10,}/, // Slack token
    /AKIA[0-9A-Z]{16}/, // AWS Access Key
    /SK[0-9a-fA-F]{32}/, // Generic Secret Keys
    /bearer\s+[A-Za-z0-9-_=]+\.[A-Za-z0-9-_=]+\.?[A-Za-z0-9-_.+/=]*/i, // JWT token
  ];

  /**
   * Scans text content for potential API keys or high-entropy credentials.
   * Throws an error or returns true if a secret is discovered.
   */
  public static detectSecrets(content: string): boolean {
    for (const pattern of this.SECRET_PATTERNS) {
      if (pattern.test(content)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Replaces every credential-looking match with a redaction marker. Used by the
   * secret-on-persist gate so an episode carrying a leaked key is still stored
   * (preserving the record) but with the secret value scrubbed.
   */
  public static redactSecrets(content: string): string {
    let out = content;
    for (const pattern of this.SECRET_PATTERNS) {
      const flags = pattern.flags.includes("g") ? pattern.flags : pattern.flags + "g";
      out = out.replace(new RegExp(pattern.source, flags), "[REDACTED-SECRET]");
    }
    return out;
  }

  /**
   * Line-based chunking with configurable overlap.
   */
  public static chunkText(content: string, options: ChunkingOptions = {}): string[] {
    const chunkSize = options.chunkSize ?? 500;
    const chunkOverlap = options.chunkOverlap ?? 50;

    const lines = content.split("\n");
    const chunks: string[] = [];

    let currentChunk: string[] = [];
    let currentLength = 0;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      currentChunk.push(line);
      currentLength += line.length + 1; // Count newlines

      if (currentLength >= chunkSize) {
        chunks.push(currentChunk.join("\n"));
        // Keep overlap lines
        const overlapCount = Math.min(
          currentChunk.length,
          Math.max(1, Math.floor(chunkOverlap / 20))
        );
        currentChunk = currentChunk.slice(currentChunk.length - overlapCount);
        currentLength = currentChunk.join("\n").length;
      }
    }

    if (currentChunk.length > 0) {
      chunks.push(currentChunk.join("\n"));
    }

    return chunks;
  }

  /**
   * Simple AST-aware chunking for code (Python, JS, TS) detecting function/class/block starts.
   */
  public static astChunkText(content: string, language: string = "ts", options: ChunkingOptions = {}): string[] {
    const chunkSize = options.chunkSize ?? 800;
    const lines = content.split("\n");
    const chunks: string[] = [];

    let currentChunk: string[] = [];
    let currentLength = 0;

    // Detect function/class definition boundaries
    const isBoundary = (line: string): boolean => {
      const trimmed = line.trim();
      if (language === "python") {
        return trimmed.startsWith("def ") || trimmed.startsWith("class ");
      } else {
        // JS/TS/Go boundaries
        return (
          trimmed.startsWith("function ") ||
          trimmed.startsWith("class ") ||
          trimmed.startsWith("export function ") ||
          trimmed.startsWith("export class ") ||
          trimmed.startsWith("async function ") ||
          trimmed.startsWith("export async function ")
        );
      }
    };

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      
      // If we encounter a boundary and have enough content, flush it
      if (isBoundary(line) && currentLength >= chunkSize / 2 && currentChunk.length > 0) {
        chunks.push(currentChunk.join("\n"));
        currentChunk = [];
        currentLength = 0;
      }

      currentChunk.push(line);
      currentLength += line.length + 1;

      if (currentLength >= chunkSize) {
        chunks.push(currentChunk.join("\n"));
        currentChunk = [];
        currentLength = 0;
      }
    }

    if (currentChunk.length > 0) {
      chunks.push(currentChunk.join("\n"));
    }

    return chunks;
  }

  /**
   * Semantically merge small adjacent chunks if they are highly similar.
   */
  public static mergeAdjacentChunks(
    chunks: { text: string; vector: number[] }[],
    cosineSimilarity: (a: number[], b: number[]) => number,
    options: ChunkingOptions = {}
  ): { text: string; vector: number[] }[] {
    const mergeThreshold = options.mergeThreshold ?? 0.85;
    if (chunks.length <= 1) return chunks;

    const merged: { text: string; vector: number[] }[] = [];
    let current = chunks[0]!;

    for (let i = 1; i < chunks.length; i++) {
      const next = chunks[i]!;
      const sim = cosineSimilarity(current.vector, next.vector);

      if (sim >= mergeThreshold) {
        // Merge chunks by combining text and average vector
        const mergedText = current.text + "\n" + next.text;
        const mergedVector = current.vector.map((val, idx) => (val + next.vector[idx]!) / 2);
        current = { text: mergedText, vector: mergedVector };
      } else {
        merged.push(current);
        current = next;
      }
    }

    merged.push(current);
    return merged;
  }
}
