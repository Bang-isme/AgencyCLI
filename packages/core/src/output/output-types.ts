export type OutputTier = "primary" | "secondary" | "tertiary" | "background";
export type Confidence = "HIGH" | "MEDIUM" | "LOW";
export type Risk = "LOW" | "MEDIUM" | "HIGH";
export type Validation = "PASSED" | "WARNINGS" | "FAILED" | "PENDING";

export interface OutputEvent {
  source: string;
  message: string;
  tier?: OutputTier;
  confidence?: Confidence;
}

export interface OutputResult {
  title?: string;
  entries: Array<{ key: string; value: string }>;
}

export interface OutputFailure {
  title: string;
  consequence: string;
  recovery: string;
  recoveryCommand?: string;
  rolledBack?: boolean;
  severity?: "warning" | "error" | "critical";
}

export interface OutputPatchChange {
  action: "MODIFY" | "ADD" | "REMOVE" | "RENAME";
  target: string;
  file?: string;
}

export interface OutputPatch {
  title?: string;
  changes: OutputPatchChange[];
  hiddenCount?: number;
  risk?: Risk;
  confidence?: Confidence;
  validation?: Validation;
}

export interface OutputPhase {
  label: string;
  meta?: Record<string, string>;
}

export interface OutputTable {
  title?: string;
  headers: string[];
  rows: string[][];
  compact?: boolean;
}

export interface OutputStatus {
  label: string;
  value: string;
  tier?: OutputTier;
}

export interface OutputWorkerStatus {
  workerId: string;
  status: "queued" | "running" | "gate" | "done" | "aborted" | "retrying";
  task?: string;
  elapsedMs?: number;
}

export interface OutputTrustBadge {
  risk?: Risk;
  confidence?: Confidence;
  validation?: Validation;
  rollbackReady?: boolean;
}

export interface OutputEngineConfig {
  surface: "human" | "json";
  quiet?: boolean;
  color?: boolean;
}
