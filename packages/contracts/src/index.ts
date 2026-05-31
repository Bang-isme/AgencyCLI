export interface ExecutionContext {
  sessionId: string;
  traceId: string;
  replayId?: string;
  workspaceId: string;
  cancellationToken: { aborted: boolean };
  governanceContext: GovernanceContext;
  retrievalScope: string[];
  schedulerScope: string[];
  sandboxScope: string;
}

export interface GovernanceContext {
  tokenBudgetLimit: number;
  tokensConsumed: number;
  costCeilingUsd: number;
  costConsumedUsd: number;
  maxAttemptsLimit: number;
}

export type PatchType =
  | "InsertFunction"
  | "ReplaceMethodBody"
  | "RenameSymbol"
  | "ModifyImport"
  | "DeleteNode";

export interface PatchOperation {
  type: PatchType;
  filePath: string;
  targetName: string; // function/method name, symbol name
  replacementContent?: string;
  meta?: Record<string, any>;
}

export interface ReplayEvent {
  sequenceId: number;
  timestamp: number;
  action: string;
  payloadHash: string;
  payload: string;
  // Optional attribution for forensics / per-agent + per-task cost accounting.
  // Additive: absent on legacy events, never affects the replay payload hash.
  agentId?: string;
  taskId?: string;
  durationMs?: number;
  costUsd?: number;
}

export interface DagTaskNode {
  id: string;
  dependencies: string[];
  action: string;
  params: Record<string, any>;
  state: "PENDING" | "RUNNING" | "COMPLETED" | "FAILED" | "SKIPPED" | "PAUSED";
  timeoutMs: number;
  attempts: number;
}
export interface ExecutionDagContract {
  nodes: Record<string, DagTaskNode>;
  rollbackPaths: Record<string, string[]>;
}

export type AutonomyMode = "Safe" | "Balanced" | "Autonomous" | "CI";
export type RiskLevel = "LOW" | "MEDIUM" | "HIGH";

export interface RiskScore {
  filesystem: number;     // 0-1 filesystem mutation risk
  shell: number;          // 0-1 shell command risk
  network: number;        // 0-1 network egress risk
  privilege: number;      // 0-1 privilege escalation risk
  impact: number;         // 0-1 codebase impact risk
  destructive: number;    // 0-1 destructive potential
  overall: number;        // 0-1 combined scored risk
  level: RiskLevel;
}

export type ApprovalScopeType =
  | "tool-level"
  | "patch-level"
  | "branch-level"
  | "session-level"
  | "sandbox-level"
  | "escalation-level";

export interface TemporaryApprovalWindow {
  grantedAt: number;
  durationMs: number;
  allowedRiskLevels: RiskLevel[];
}

export type ContinuationPolicy = "Reject" | "ReadonlyFallback" | "ProceedAutonomous";

export interface ApprovalRequest {
  id: string;
  scope: ApprovalScopeType;
  action: string;
  params: Record<string, any>;
  risk: RiskScore;
  branchId?: string;
  timeoutMs: number;
}

export type RuntimeSource =
  | "planner"
  | "scheduler"
  | "worker"
  | "retrieval"
  | "validator"
  | "sandbox"
  | "risk-engine"
  | "governance"
  | "replay-engine";

export type RuntimePhase =
  | "planning"
  | "retrieval"
  | "editing"
  | "validation"
  | "rollback"
  | "recovery"
  | "replay";

export type RuntimeSeverity = "info" | "adaptation" | "warning" | "critical";

export interface RuntimeThoughtEvent {
  id: string;
  source: RuntimeSource;
  phase: RuntimePhase;
  severity: RuntimeSeverity;
  confidence?: "high" | "medium" | "low";
  message: string;
  timestamp: number;
  workerId?: string;
  branchId?: string;
  collapsible?: boolean;
  hiddenByDefault?: boolean;
}

/**
 * Operational execution phases — what the system is doing RIGHT NOW.
 * NEVER expose: "thinking", "exploring", "reasoning", "analyzing internally".
 * ALWAYS expose: verifiable execution state.
 */
export type ExecutionPhase =
  | "idle"
  | "routing"
  | "reading"
  | "writing"
  | "validating"
  | "recovering"
  | "rolling_back";

/**
 * Execution worker state — coordination status for autonomous tasks.
 */
export interface ExecutionWorkerState {
  workerId: string;
  taskId: string;
  status: "queued" | "running" | "gate" | "done" | "aborted" | "retrying";
  attempt: number;
  maxAttempts: number;
  startedAt: number;
  completedSteps: number;
  totalSteps: number;
}

/**
 * ExecutionProgress — the unified runtime state contract.
 * This replaces ad-hoc goal-running state in App.tsx.
 */
export interface ExecutionProgress {
  /** Active goal / task description */
  task: string | null;
  /** Workers for parallel agent dispatch */
  workers: ExecutionWorkerState[];
  /** Aggregate progress: steps completed vs total */
  completedSteps: number;
  totalSteps: number;
  /** Elapsed since execution started */
  elapsedMs: number;
  /** Current worker that's active */
  activeWorkerId: string | null;
  /** Is execution currently in progress? */
  active: boolean;
}

export interface ProviderExecutionContext {
  /** Which provider is serving this request */
  providerId: string;
  /** Model name */
  modelName: string;
  /** Token budget plan (tight/normal/deep) */
  budgetMode: "tight" | "normal" | "deep";
  /** Established thinking variant */
  thinkingVariant?: string;
  /** Whether the context was routed (vs direct provider call) */
  routed: boolean;
  /** Routing intent */
  intent?: string;
  /** Total context window */
  contextWindow: number;
  /** Estimated context usage percentage */
  contextUsedPercent: number;
}

export type RuntimeThoughtSource = RuntimeSource;
export type RuntimeThoughtPhase = RuntimePhase;
export type RuntimeThoughtSeverity = RuntimeSeverity;

