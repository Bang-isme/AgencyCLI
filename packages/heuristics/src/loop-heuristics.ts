import { createHash } from "node:crypto";

export interface LoopDetectionResult {
  loopDetected: boolean;
  reason?: string;
}

export class LoopDetector {
  private prompts: string[] = [];
  private errors: string[] = [];
  private patchHistory: Map<string, string[]> = new Map(); // filePath -> array of patch hashes

  /**
   * Tracks an outgoing prompt to the LLM.
   */
  addPrompt(prompt: string): void {
    this.prompts.push(prompt.trim());
    if (this.prompts.length > 10) {
      this.prompts.shift();
    }
  }

  /**
   * Tracks an error or compile output signature.
   */
  addError(error: string): void {
    this.errors.push(error.trim());
    if (this.errors.length > 10) {
      this.errors.shift();
    }
  }

  /**
   * Tracks a patch applied to a file.
   */
  addPatch(filePath: string, patchContent: string): void {
    const hash = createHash("sha256").update(patchContent.trim()).digest("hex");
    if (!this.patchHistory.has(filePath)) {
      this.patchHistory.set(filePath, []);
    }
    const history = this.patchHistory.get(filePath)!;
    history.push(hash);
    if (history.length > 10) {
      history.shift();
    }
  }

  /**
   * Evaluates all tracked metrics to detect infinite loops.
   */
  detectLoop(): LoopDetectionResult {
    // 1. Consecutive identical error loop detection (3 times)
    if (this.errors.length >= 3) {
      const lastIndex = this.errors.length - 1;
      const err1 = this.errors[lastIndex];
      const err2 = this.errors[lastIndex - 1];
      const err3 = this.errors[lastIndex - 2];
      if (err1 && err1 === err2 && err2 === err3) {
        return {
          loopDetected: true,
          reason: `Consecutive identical error loop detected: "${err1.slice(0, 100)}..." occurred 3 times.`,
        };
      }
    }

    // 2. Prompt loop detection (identical consecutive prompts or patterns)
    if (this.prompts.length >= 3) {
      const lastIndex = this.prompts.length - 1;
      const p1 = this.prompts[lastIndex];
      const p2 = this.prompts[lastIndex - 1];
      const p3 = this.prompts[lastIndex - 2];
      if (p1 && p1 === p2 && p2 === p3) {
        return {
          loopDetected: true,
          reason: "Prompt cycle detected: identical system prompts or completions generated 3 times.",
        };
      }
    }

    // 3. Back-and-forth patch edit loop detection (A -> B -> A -> B)
    for (const [filePath, history] of this.patchHistory.entries()) {
      if (history.length >= 4) {
        const lastIndex = history.length - 1;
        const h1 = history[lastIndex];
        const h2 = history[lastIndex - 1];
        const h3 = history[lastIndex - 2];
        const h4 = history[lastIndex - 3];

        // Pattern A -> B -> A -> B
        if (h1 === h3 && h2 === h4 && h1 !== h2) {
          return {
            loopDetected: true,
            reason: `Back-and-forth cyclic file edits detected on file: ${filePath}`,
          };
        }
      }
    }

    return { loopDetected: false };
  }

  /**
   * Resets all history.
   */
  clear(): void {
    this.prompts = [];
    this.errors = [];
    this.patchHistory.clear();
  }
}
