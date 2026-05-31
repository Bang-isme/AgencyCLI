export interface ToolTraceEntry {
  toolName: string;
  arguments: Record<string, any>;
  output: any;
  timestamp: number;
}

export interface DeterministicExecutionTrace {
  sessionId: string;
  goal: string;
  initialGitHash?: string;
  providerSeed?: number;
  timings: number[]; // Duration of each agent turn in ms
  toolOutputs: ToolTraceEntry[];
}

export interface TelemetryTracker {
  startSession(sessionId: string, goal: string): void;
  recordTurn(durationMs: number): void;
  recordToolCall(toolName: string, args: Record<string, any>, output: any): void;
  exportTrace(): DeterministicExecutionTrace;
}
