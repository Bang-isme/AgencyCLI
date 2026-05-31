import type { DeterministicExecutionTrace } from "./types.js";

/**
 * Deep equality helper to match structurally equivalent JSON payloads.
 */
function deepEqual(a: any, b: any): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || a === null || typeof b !== "object" || b === null) return false;
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;
  for (const key of keysA) {
    if (!keysB.includes(key)) return false;
    if (!deepEqual(a[key], b[key])) return false;
  }
  return true;
}

/**
 * Stateful Replay Engine which overrides live tool and clock execution with recorded traces.
 */
export class ReplayEngine {
  private trace: DeterministicExecutionTrace;
  private consumedOutputs: Set<number> = new Set();
  private currentTurnIndex = 0;

  constructor(trace: DeterministicExecutionTrace) {
    this.trace = trace;
  }

  /**
   * Retrieves the duration of the next recorded turn, simulating exact latency profiles.
   */
  nextTurnDuration(): number {
    const duration = this.trace.timings[this.currentTurnIndex];
    if (duration !== undefined) {
      this.currentTurnIndex++;
      return duration;
    }
    return 100; // Baseline fallback duration
  }

  /**
   * Resolves the tool call using recorded trace outputs by fuzzy-matching arguments.
   * Consumes matched entries sequentially to support multiple identical tool invocations.
   */
  interceptToolCall(toolName: string, args: Record<string, any>): any {
    for (let i = 0; i < this.trace.toolOutputs.length; i++) {
      if (this.consumedOutputs.has(i)) continue;
      const entry = this.trace.toolOutputs[i]!;
      
      if (entry.toolName === toolName && deepEqual(entry.arguments, args)) {
        this.consumedOutputs.add(i);
        return entry.output;
      }
    }
    
    throw new Error(
      `[Replay Deviation] No matching recorded trace entry found for tool "${toolName}" with arguments: ${JSON.stringify(args)}`
    );
  }

  /**
   * Returns the count of trace outputs that have not been consumed during replay.
   */
  getUnconsumedCount(): number {
    return this.trace.toolOutputs.length - this.consumedOutputs.size;
  }

  /**
   * Returns the active turn index.
   */
  getCurrentTurnIndex(): number {
    return this.currentTurnIndex;
  }
}
