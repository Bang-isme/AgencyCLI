export type MemoryState =
  | "ACTIVE"
  | "HOT"
  | "WARM"
  | "COLD"
  | "ARCHIVED"
  | "INVALIDATED"
  | "QUARANTINED"
  | "REBUILDING"
  | "DEGRADED";

export interface Episode {
  id?: number;
  tenant_id: string;
  workspace_id?: string;
  project_id?: string;
  session_id: string;
  agent_id?: string;
  memory_type: string;
  state: MemoryState;
  goal: string;
  turn_index: number;
  action_signature: string;
  content: string;
  metadata: any;
  created_at: number;
  expires_at?: number;
  is_archived: number;
  confidence_score: number;
  decay_factor: number;
  lamport_timestamp: number;
  source_file?: string;
  source_type?: string;
  origin_agent_id?: string;
  origin_workflow_id?: string;
  origin_git_commit?: string;
  lineage_parent_id?: number;
}

export interface VectorEntry {
  id: string;
  tenant_id: string;
  workspace_id?: string;
  project_id?: string;
  session_id?: string;
  agent_id?: string;
  memory_type: string;
  state: MemoryState;
  vector: number[];
  content: string;
  metadata: any;
  embedding_model?: string;
  embedding_dimension?: number;
  embedding_version?: string;
  file_path?: string;
  symbol_type?: string;
  git_revision?: string;
  source_file?: string;
  source_type?: string;
  origin_agent_id?: string;
  origin_workflow_id?: string;
  origin_git_commit?: string;
  lineage_parent_id?: string;
  lamport_timestamp: number;
}

export interface GraphEdge {
  source_id: string;
  target_id: string;
  relation_type: string;
  weight: number;
  metadata: any;
}

export interface EventLogEntry {
  sequence_id?: number;
  timestamp: number;
  action: string;
  payload: string;
}

export interface AuditEntry {
  id?: number;
  record_id: string;
  table_name: string;
  actor: string;
  reason: string;
  mutation_type: "INSERT" | "UPDATE" | "DELETE" | "ROLLBACK";
  pre_state: any;
  post_state: any;
  timestamp: number;
}

export interface QueryOptions {
  limit?: number;
  similarityThreshold?: number;
  maxTokens?: number;
  offset?: number;
  tenant_id?: string;
}

export interface ExecutionCtx {
  activeTaskId?: string;
  currentBranch?: string;
  editedFiles?: string[];
  plannerGoals?: string[];
}

export type RetrievalProfile = "planner" | "coder" | "reviewer";

export interface StorageTelemetry {
  page_size: number;
  page_count: number;
  freelist_count: number;
  database_size_bytes: number;
  wal_size_bytes: number;
  episodes_count: number;
  vectors_count: number;
  graph_edges_count: number;
  cache_hit_count: number;
  cache_miss_count: number;
  cache_efficiency_ratio: number;
}

export interface Explanation {
  base_score: number;
  recency_boost: number;
  dependency_boost: number;
  reranker_shift: number;
  final_score: number;
  reason: string;
}
