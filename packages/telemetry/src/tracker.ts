import type { TelemetryTracker, DeterministicExecutionTrace, ToolTraceEntry } from "./types.js";

export class ActiveTelemetryTracker implements TelemetryTracker {
  private sessionId = "";
  private goal = "";
  private timings: number[] = [];
  private toolOutputs: ToolTraceEntry[] = [];
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

  exportTrace(): DeterministicExecutionTrace {
    return {
      sessionId: this.sessionId,
      goal: this.goal,
      initialGitHash: this.initialGitHash,
      providerSeed: this.providerSeed,
      timings: [...this.timings],
      toolOutputs: [...this.toolOutputs],
    };
  }
}
