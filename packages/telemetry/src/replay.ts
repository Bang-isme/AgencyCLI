import type { DeterministicExecutionTrace, LlmResponseEntry } from "./types.js";

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
  /** The model completions in recorded order (missing in pre-§2.5 traces → []). */
  private llmResponses: LlmResponseEntry[];
  private nextLlmIndex = 0;

  constructor(trace: DeterministicExecutionTrace) {
    this.trace = trace;
    this.llmResponses = trace.llmResponses ?? [];
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
   * Consumes the next recorded LLM completion in order and asserts it matches the
   * one the re-execution produced. Unlike tool calls (matched by arguments) the
   * completions are ordered by turn, so this is positional — the §2.5 analogue of
   * {@link interceptToolCall}: a differing or extra response is behavioural drift.
   */
  interceptLlmResponse(text: string): LlmResponseEntry {
    const entry = this.llmResponses[this.nextLlmIndex];
    if (entry === undefined) {
      throw new Error(
        `[Replay Deviation] No recorded LLM response remains for completion #${this.nextLlmIndex + 1}: ${JSON.stringify(text.slice(0, 80))}`
      );
    }
    if (entry.text !== text) {
      throw new Error(
        `[Replay Deviation] LLM response #${this.nextLlmIndex + 1} diverged from the recorded trace`
      );
    }
    this.nextLlmIndex++;
    return entry;
  }

  /**
   * Returns the count of recorded LLM responses not yet consumed during replay
   * (0 for pre-§2.5 traces that recorded no completions).
   */
  getUnconsumedLlmCount(): number {
    return this.llmResponses.length - this.nextLlmIndex;
  }

  /**
   * Returns the active turn index.
   */
  getCurrentTurnIndex(): number {
    return this.currentTurnIndex;
  }
}
