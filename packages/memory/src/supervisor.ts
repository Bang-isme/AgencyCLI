import { MemoryStorageBackend } from "./storage-backend.js";
import { RevisionMismatch } from "./types.js";

export function yieldNow(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

export class Supervisor {
  private backend: MemoryStorageBackend;

  constructor(backend: MemoryStorageBackend) {
    this.backend = backend;
  }

  /**
   * Safe retrying write transactions with backoff limits
   */
  public safeWrite<T>(action: () => T, maxRetries = 3, initialDelayMs = 50): T {
    let attempts = 0;
    let delay = initialDelayMs;

    while (attempts < maxRetries) {
      try {
        return this.backend.runTransaction(action);
      } catch (err: any) {
        attempts++;
        if (attempts >= maxRetries) {
          throw new Error(`Write transaction failed after ${maxRetries} attempts. Source error: ${err.message}`);
        }
        // Synchronous sleep blocking to coordinate write locks
        this.sleep(delay);
        delay *= 2; // exponential backoff
      }
    }

    throw new Error("Supervisor transaction failed unreachably.");
  }

  /**
   * Safe retrying write transactions asynchronously with backoff and yielding
   */
  public async safeWriteAsync<T>(
    action: () => T,
    maxRetries = 5,
    initialDelayMs = 50
  ): Promise<T> {
    let attempts = 0;
    let delay = initialDelayMs;

    while (attempts < maxRetries) {
      try {
        return this.backend.runTransaction(action);
      } catch (err: any) {
        const isRevisionMismatch = err instanceof RevisionMismatch;
        const isSqliteBusy =
          err?.code === "SQLITE_BUSY" ||
          (err?.message && err.message.includes("SQLITE_BUSY"));

        if (!isRevisionMismatch && !isSqliteBusy) {
          throw err;
        }

        attempts++;
        if (attempts >= maxRetries) {
          throw new Error(
            `Write transaction failed after ${maxRetries} attempts. Source error: ${err.message}`
          );
        }

        await yieldNow();
        await new Promise((resolve) => setTimeout(resolve, delay));
        delay *= 2; // exponential backoff
      }
    }

    throw new Error("Supervisor transaction failed unreachably.");
  }

  private sleep(ms: number): void {
    const start = Date.now();
    while (Date.now() - start < ms) {
      // Synchronous thread sleep block
    }
  }

  /**
   * Moves invalid or corrupt dimension inputs to the quarantined_vectors table
   */
  public quarantineCorruptVector(id: string, vector: number[], error: string): void {
    const stmt = (this.backend as any).db?.prepare(`
      INSERT INTO quarantined_vectors (id, vector, error, quarantined_at)
      VALUES (?, ?, ?, ?)
    `);

    if (stmt) {
      stmt.run(id, JSON.stringify(vector), error, Date.now());
    }
  }
}
