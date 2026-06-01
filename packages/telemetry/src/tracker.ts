import type {
  TelemetryTracker,
  DeterministicExecutionTrace,
  ToolTraceEntry,
  LlmResponseEntry,
} from "./types.js";

export class ActiveTelemetryTracker implements TelemetryTracker {
  private sessionId = "";
  private goal = "";
  private timings: number[] = [];
  private toolOutputs: ToolTraceEntry[] = [];
  private llmResponses: LlmResponseEntry[] = [];
  private initialGitHash?: string;
  private providerSeed?: number;

  constructor(options?: { initialGitHash?: string; providerSeed?: number }) {
    this.initialGitHash = options?.initialGitHash;
    this.providerSeed = options?.providerSeed;
  }

  startSession(sessionId: string, goal: string): void {
    this.sessionId = sessionId;
    this.goal = goal;
    this.timings = [];
    this.toolOutputs = [];
    this.llmResponses = [];
  }

  recordTurn(durationMs: number): void {
    this.timings.push(durationMs);
  }

  recordToolCall(toolName: string, args: Record<string, any>, output: any): void {
    this.toolOutputs.push({
      toolName,
      arguments: args,
      output,
      timestamp: Date.now(),
    });
  }

  recordLlmResponse(text: string, finishReason?: string): void {
    this.llmResponses.push({
      text,
      finishReason,
      timestamp: Date.now(),
    });
  }

  exportTrace(): DeterministicExecutionTrace {
    return {
      sessionId: this.sessionId,
      goal: this.goal,
      initialGitHash: this.initialGitHash,
      providerSeed: this.providerSeed,
      timings: [...this.timings],
      toolOutputs: [...this.toolOutputs],
      llmResponses: [...this.llmResponses],
    };
  }
}
