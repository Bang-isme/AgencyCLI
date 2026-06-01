export {
  MemoryState,
  Episode,
  VectorEntry,
  GraphEdge,
  EventLogEntry,
  AuditEntry,
  QueryOptions,
  ExecutionCtx,
  RetrievalProfile,
  StorageTelemetry,
  Explanation,
} from "./types.js";

export {
  MemoryStorageBackend,
  SqliteStorageBackend,
  RemoteSyncAdapter,
  ClusterCoordinator,
} from "./storage-backend.js";

export {
  getDb,
  closeDb,
  closeAllDbs,
} from "./db.js";

export {
  Migration,
  MIGRATIONS,
  runMigrations,
  rollbackMigration,
} from "./migrations.js";

export {
  WriteQueue,
  globalWriteQueue,
} from "./write-queue.js";

export {
  ChunkingOptions,
  IngestionPipeline,
} from "./ingestion.js";

export {
  setSecretScanEnabled,
  isSecretScanEnabled,
} from "./secret-policy.js";

export {
  VectorStore,
  computeCosineSimilarity,
  loadNativeKernel,
} from "./vector-store.js";

export {
  EpisodicStore,
} from "./episodic-store.js";

export {
  GraphStore,
} from "./graph-store.js";

export {
  AuditLog,
} from "./audit.js";

export {
  FederatedMemoryManager,
  HybridRetriever,
} from "./retriever.js";

export {
  type Embedder,
  LocalDeterministicEmbedder,
} from "./embedder.js";

export {
  MarkdownMemoryStore,
  parseMemoryFile,
  serializeMemoryFile,
  slugifyMemoryName,
  type MemoryRecord,
  type MemoryType,
  type MemoryRecallOptions,
} from "./markdown-memory.js";

export {
  PolicyEngine,
  GraphIntegritySupervisor,
  RecoverySupervisor,
  CrdtMerger,
} from "./lifecycle.js";

export {
  MemoryLifecycleManager,
  runMemoryMaintenance,
  DEFAULT_LIFECYCLE_OPTIONS,
  type MemoryLifecycleOptions,
  type GcReport,
} from "./lifecycle-manager.js";


export {
  IndexPayload,
} from "./worker.js";

export {
  MemoryCache,
} from "./cache.js";

export {
  MemoryBudgetAllocator,
  CapabilityNegotiator,
} from "./governance.js";

export {
  SecurityHardening,
} from "./security.js";

export {
  Supervisor,
} from "./supervisor.js";

export {
  DashboardServer,
} from "./dashboard.js";
