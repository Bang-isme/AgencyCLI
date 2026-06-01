export interface ToolTraceEntry {
  toolName: string;
  arguments: Record<string, any>;
  output: any;
  timestamp: number;
}

/**
 * One LLM completion produced during a session (one per outer tool-loop
 * iteration). Recording these is what makes a trace *deterministically
 * re-runnable* (§2.5): the tool I/O alone replays what the harness did with the
 * model's words, but not the words themselves. For a seeded/deterministic
 * provider (see {@link DeterministicExecutionTrace.providerSeed}) the same goal
 * should reproduce the same response sequence — a real behaviour-regression
 * signal.
 */
export interface LlmResponseEntry {
  text: string;
  finishReason?: string;
  timestamp: number;
}

export interface DeterministicExecutionTrace {
  sessionId: string;
  goal: string;
  initialGitHash?: string;
  providerSeed?: number;
  timings: number[]; // Duration of each agent turn in ms
  toolOutputs: ToolTraceEntry[];
  /**
   * The model's completion for each outer-loop iteration, in order. Optional so
   * traces recorded before §2.5's LLM-response capture still load and replay
   * (consumers treat a missing array as empty).
   */
  llmResponses?: LlmResponseEntry[];
}

export interface TelemetryTracker {
  startSession(sessionId: string, goal: string): void;
  recordTurn(durationMs: number): void;
  recordToolCall(toolName: string, args: Record<string, any>, output: any): void;
  recordLlmResponse(text: string, finishReason?: string): void;
  exportTrace(): DeterministicExecutionTrace;
}
