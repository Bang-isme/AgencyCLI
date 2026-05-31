import type { Database } from "better-sqlite3";
import {
  Episode,
  VectorEntry,
  GraphEdge,
  AuditEntry,
  StorageTelemetry,
} from "./types.js";
import { IngestionPipeline } from "./ingestion.js";
import { isSecretScanEnabled } from "./secret-policy.js";

export interface MemoryStorageBackend {
  addEpisode(episode: Episode): void;
  queryEpisodes(sessionId: string, tenantId?: string): Episode[];
  queryEpisodesByAction(sessionId: string, actionSignature: string, tenantId?: string): Episode[];
  searchEpisodesFTS(matchQuery: string, tenantId?: string): Episode[];
  deleteEpisodes(sessionId: string, tenantId?: string): void;

  insertVector(entry: VectorEntry): void;
  queryVectors(tenantId?: string): VectorEntry[];
  deleteVector(id: string, tenantId?: string): void;

  addEdge(edge: GraphEdge): void;
  removeEdge(sourceId: string, targetId: string, relationType: string): void;
  getNeighbors(sourceId: string): GraphEdge[];

  logMutation(audit: AuditEntry): number;
  getAuditHistory(recordId: string): AuditEntry[];

  logEvent(action: string, payload: string): number;
  getEvents(afterSeqId?: number): { sequence_id: number; timestamp: number; action: string; payload: string }[];

  runTransaction<T>(fn: () => T): T;
  integrityCheck(): boolean;
  vacuum(): void;
  getTelemetry(): StorageTelemetry;
  close(): void;

  // --- Lifecycle / bounded-growth maintenance (P1) ---
  countEpisodes(): number;
  countVectors(): number;
  /** Deletes least-valuable episodes (archived → low-confidence → oldest) until at most `maxRows` remain. Returns rows deleted. */
  pruneEpisodesByQuota(maxRows: number): number;
  /** Deletes oldest vectors (lowest lamport) until at most `maxRows` remain. Returns rows deleted. */
  pruneVectorsByQuota(maxRows: number): number;
  /** Removes duplicate episodes sharing (tenant, session, action_signature, content), keeping the newest. Returns rows deleted. */
  dedupeEpisodes(): number;
  /** Multiplies confidence of non-archived episodes older than `graceMs` by `decayRate`. Returns rows updated. */
  applyEpisodeDecay(decayRate: number, graceMs: number, now: number): number;
}

export interface RemoteSyncAdapter {
  pushEvents(events: any[]): Promise<void>;
  pullEvents(afterSeqId: number): Promise<any[]>;
}

export interface ClusterCoordinator {
  acquireLock(lockKey: string, ttlMs: number): boolean;
  releaseLock(lockKey: string): void;
  isLeader(): boolean;
  electLeader(): Promise<boolean>;
}

export class SqliteStorageBackend implements MemoryStorageBackend {
  private db: Database;
  private cacheHits = 0;
  private cacheMisses = 0;
  private secretsRedacted = 0;
  private secretsQuarantined = 0;
  public simulateEnfile = false;
  public simulateEnospc = false;

  constructor(db: Database) {
    this.db = db;
  }

  private checkChaos(): void {
    if (this.simulateEnfile) {
      throw new Error("SqliteError: SQLITE_CANTOPEN: OS Error 24 (ENFILE: too many open files)");
    }
    if (this.simulateEnospc) {
      throw new Error("SqliteError: SQLITE_FULL: OS Error 28 (ENOSPC: no space left on device)");
    }
  }


  public recordCacheHit(): void {
    this.cacheHits++;
  }

  public recordCacheMiss(): void {
    this.cacheMisses++;
  }

  /** Secret-on-persist stats for telemetry/observability. */
  public getSecretScanStats(): { redacted: number; quarantined: number } {
    return { redacted: this.secretsRedacted, quarantined: this.secretsQuarantined };
  }

  /** Moves a secret-bearing or corrupt vector to the quarantine table instead of the live store. */
  private quarantineVector(id: string, vector: number[], error: string): void {
    try {
      this.db
        .prepare(`INSERT INTO quarantined_vectors (id, vector, error, quarantined_at) VALUES (?, ?, ?, ?)`)
        .run(id, JSON.stringify(vector ?? []), error, Date.now());
    } catch {
      // Quarantine is best-effort; never let it throw into the write path.
    }
  }

  addEpisode(episode: Episode): void {
    this.checkChaos();

    // Secret-on-persist: scrub any credential-looking value from the content
    // before it lands in the store (and the FTS index). Off by default (legacy).
    let content = episode.content;
    if (isSecretScanEnabled() && typeof content === "string" && IngestionPipeline.detectSecrets(content)) {
      content = IngestionPipeline.redactSecrets(content);
      this.secretsRedacted++;
    }

    const stmt = this.db.prepare(`
      INSERT INTO episodes (
        tenant_id, workspace_id, project_id, session_id, agent_id, memory_type, state,
        goal, turn_index, action_signature, content, metadata, created_at, expires_at,
        is_archived, confidence_score, decay_factor, lamport_timestamp,
        source_file, source_type, origin_agent_id, origin_workflow_id, origin_git_commit, lineage_parent_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      episode.tenant_id,
      episode.workspace_id ?? null,
      episode.project_id ?? null,
      episode.session_id,
      episode.agent_id ?? null,
      episode.memory_type,
      episode.state,
      episode.goal,
      episode.turn_index,
      episode.action_signature,
      content,
      JSON.stringify(episode.metadata ?? {}),
      episode.created_at,
      episode.expires_at ?? null,
      episode.is_archived,
      episode.confidence_score,
      episode.decay_factor,
      episode.lamport_timestamp,
      episode.source_file ?? null,
      episode.source_type ?? null,
      episode.origin_agent_id ?? null,
      episode.origin_workflow_id ?? null,
      episode.origin_git_commit ?? null,
      episode.lineage_parent_id ?? null
    );
  }

  private parseMetadata(str: string): any {
    try {
      return JSON.parse(str);
    } catch {
      return {};
    }
  }

  queryEpisodes(sessionId: string, tenantId: string = "default"): Episode[] {
    const stmt = this.db.prepare(`
      SELECT * FROM episodes
      WHERE session_id = ? AND tenant_id = ?
      ORDER BY created_at ASC
    `);

    const rows = stmt.all(sessionId, tenantId) as any[];
    return rows.map((r) => ({
      ...r,
      metadata: this.parseMetadata(r.metadata),
    }));
  }

  queryEpisodesByAction(sessionId: string, actionSignature: string, tenantId: string = "default"): Episode[] {
    const stmt = this.db.prepare(`
      SELECT * FROM episodes
      WHERE session_id = ? AND action_signature = ? AND tenant_id = ?
      ORDER BY created_at ASC
    `);

    const rows = stmt.all(sessionId, actionSignature, tenantId) as any[];
    return rows.map((r) => ({
      ...r,
      metadata: this.parseMetadata(r.metadata),
    }));
  }

  searchEpisodesFTS(matchQuery: string, tenantId: string = "default"): Episode[] {
    // FTS5 external content query using JOIN on the external table 'episodes'
    const stmt = this.db.prepare(`
      SELECT e.* FROM episodes e
      JOIN episodes_fts f ON e.id = f.rowid
      WHERE episodes_fts MATCH ? AND e.tenant_id = ?
      ORDER BY e.created_at ASC
    `);

    const rows = stmt.all(matchQuery, tenantId) as any[];
    return rows.map((r) => ({
      ...r,
      metadata: this.parseMetadata(r.metadata),
    }));
  }

  deleteEpisodes(sessionId: string, tenantId: string = "default"): void {
    const stmt = this.db.prepare(`
      DELETE FROM episodes WHERE session_id = ? AND tenant_id = ?
    `);
    stmt.run(sessionId, tenantId);
  }

  insertVector(entry: VectorEntry): void {
    this.checkChaos();

    // Secret-on-persist: a vector whose source content carries a credential is
    // diverted to quarantine instead of the live, semantically-searchable store,
    // so the secret can never be surfaced by a similarity query. Off by default.
    if (isSecretScanEnabled() && typeof entry.content === "string" && IngestionPipeline.detectSecrets(entry.content)) {
      this.quarantineVector(entry.id, entry.vector, "secret detected in vector content");
      this.secretsQuarantined++;
      return;
    }

    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO vectors (
        id, tenant_id, workspace_id, project_id, session_id, agent_id, memory_type, state,
        vector, content, metadata, embedding_model, embedding_dimension, embedding_version,
        file_path, symbol_type, git_revision, source_file, source_type, origin_agent_id,
        origin_workflow_id, origin_git_commit, lineage_parent_id, lamport_timestamp
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      entry.id,
      entry.tenant_id,
      entry.workspace_id ?? null,
      entry.project_id ?? null,
      entry.session_id ?? null,
      entry.agent_id ?? null,
      entry.memory_type,
      entry.state,
      JSON.stringify(entry.vector),
      entry.content,
      JSON.stringify(entry.metadata ?? {}),
      entry.embedding_model ?? null,
      entry.embedding_dimension ?? null,
      entry.embedding_version ?? null,
      entry.file_path ?? null,
      entry.symbol_type ?? null,
      entry.git_revision ?? null,
      entry.source_file ?? null,
      entry.source_type ?? null,
      entry.origin_agent_id ?? null,
      entry.origin_workflow_id ?? null,
      entry.origin_git_commit ?? null,
      entry.lineage_parent_id ?? null,
      entry.lamport_timestamp
    );
  }

  queryVectors(tenantId: string = "default"): VectorEntry[] {
    const stmt = this.db.prepare(`
      SELECT * FROM vectors WHERE tenant_id = ?
    `);
    const rows = stmt.all(tenantId) as any[];
    return rows.map((r) => ({
      ...r,
      vector: JSON.parse(r.vector),
      metadata: this.parseMetadata(r.metadata),
    }));
  }

  deleteVector(id: string, tenantId: string = "default"): void {
    const stmt = this.db.prepare(`
      DELETE FROM vectors WHERE id = ? AND tenant_id = ?
    `);
    stmt.run(id, tenantId);
  }

  addEdge(edge: GraphEdge): void {
    this.checkChaos();
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO graph_edges (source_id, target_id, relation_type, weight, metadata)
      VALUES (?, ?, ?, ?, ?)
    `);
    stmt.run(
      edge.source_id,
      edge.target_id,
      edge.relation_type,
      edge.weight,
      JSON.stringify(edge.metadata ?? {})
    );
  }

  removeEdge(sourceId: string, targetId: string, relationType: string): void {
    const stmt = this.db.prepare(`
      DELETE FROM graph_edges
      WHERE source_id = ? AND target_id = ? AND relation_type = ?
    `);
    stmt.run(sourceId, targetId, relationType);
  }

  getNeighbors(sourceId: string): GraphEdge[] {
    const stmt = this.db.prepare(`
      SELECT * FROM graph_edges WHERE source_id = ?
    `);
    const rows = stmt.all(sourceId) as any[];
    return rows.map((r) => ({
      ...r,
      metadata: this.parseMetadata(r.metadata),
    }));
  }

  logMutation(audit: AuditEntry): number {
    const stmt = this.db.prepare(`
      INSERT INTO audit_log (record_id, table_name, actor, reason, mutation_type, pre_state, post_state, timestamp)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const info = stmt.run(
      audit.record_id,
      audit.table_name,
      audit.actor,
      audit.reason,
      audit.mutation_type,
      JSON.stringify(audit.pre_state ?? {}),
      JSON.stringify(audit.post_state ?? {}),
      audit.timestamp
    );
    return Number(info.lastInsertRowid);
  }

  getAuditHistory(recordId: string): AuditEntry[] {
    const stmt = this.db.prepare(`
      SELECT * FROM audit_log WHERE record_id = ? ORDER BY timestamp DESC
    `);
    const rows = stmt.all(recordId) as any[];
    return rows.map((r) => ({
      ...r,
      pre_state: this.parseMetadata(r.pre_state),
      post_state: this.parseMetadata(r.post_state),
    }));
  }

  logEvent(action: string, payload: string): number {
    const stmt = this.db.prepare(`
      INSERT INTO event_log (timestamp, action, payload)
      VALUES (?, ?, ?)
    `);
    const info = stmt.run(Date.now(), action, payload);
    return Number(info.lastInsertRowid);
  }

  getEvents(afterSeqId = 0): { sequence_id: number; timestamp: number; action: string; payload: string }[] {
    const stmt = this.db.prepare(`
      SELECT * FROM event_log WHERE sequence_id > ? ORDER BY sequence_id ASC
    `);
    return stmt.all(afterSeqId) as any[];
  }

  runTransaction<T>(fn: () => T): T {
    this.checkChaos();
    return this.db.transaction(fn)();
  }

  integrityCheck(): boolean {
    const res = this.db.prepare("PRAGMA integrity_check").get() as any;
    return res && res.integrity_check === "ok";
  }

  vacuum(): void {
    this.db.prepare("VACUUM").run();
  }

  countEpisodes(): number {
    return (this.db.prepare("SELECT count(*) as count FROM episodes").get() as any).count as number;
  }

  countVectors(): number {
    return (this.db.prepare("SELECT count(*) as count FROM vectors").get() as any).count as number;
  }

  pruneEpisodesByQuota(maxRows: number): number {
    this.checkChaos();
    const total = this.countEpisodes();
    if (total <= maxRows) return 0;
    const toDelete = total - maxRows;
    // Evict least-valuable first: archived rows, then lowest confidence, then oldest.
    // FTS5 stays in sync via the episodes_ad delete trigger.
    const info = this.db
      .prepare(
        `DELETE FROM episodes WHERE id IN (
           SELECT id FROM episodes
           ORDER BY is_archived DESC, COALESCE(confidence_score, 0) ASC, created_at ASC
           LIMIT ?
         )`
      )
      .run(toDelete);
    return info.changes;
  }

  pruneVectorsByQuota(maxRows: number): number {
    this.checkChaos();
    const total = this.countVectors();
    if (total <= maxRows) return 0;
    const toDelete = total - maxRows;
    const info = this.db
      .prepare(
        `DELETE FROM vectors WHERE id IN (
           SELECT id FROM vectors ORDER BY lamport_timestamp ASC LIMIT ?
         )`
      )
      .run(toDelete);
    return info.changes;
  }

  dedupeEpisodes(): number {
    this.checkChaos();
    // Keep the newest (max id) row of each duplicate group; delete the rest.
    const info = this.db
      .prepare(
        `DELETE FROM episodes WHERE id NOT IN (
           SELECT MAX(id) FROM episodes
           GROUP BY tenant_id, session_id, action_signature, content
         )`
      )
      .run();
    return info.changes;
  }

  applyEpisodeDecay(decayRate: number, graceMs: number, now: number): number {
    this.checkChaos();
    const info = this.db
      .prepare(
        `UPDATE episodes
           SET confidence_score = COALESCE(confidence_score, 1.0) * ?
         WHERE is_archived = 0 AND (? - created_at) > ?`
      )
      .run(decayRate, now, graceMs);
    return info.changes;
  }

  getTelemetry(): StorageTelemetry {
    const pageSize = (this.db.prepare("PRAGMA page_size").get() as any).page_size;
    const pageCount = (this.db.prepare("PRAGMA page_count").get() as any).page_count;
    const freelistCount = (this.db.prepare("PRAGMA freelist_count").get() as any).freelist_count;

    const episodesCount = (this.db.prepare("SELECT count(*) as count FROM episodes").get() as any).count;
    const vectorsCount = (this.db.prepare("SELECT count(*) as count FROM vectors").get() as any).count;
    const graphEdgesCount = (this.db.prepare("SELECT count(*) as count FROM graph_edges").get() as any).count;

    const databaseSizeBytes = pageSize * pageCount;
    // Estimated WAL size by running a query or stat, we'll keep it simple or default
    const walSizeBytes = 0; 

    const totalCacheOps = this.cacheHits + this.cacheMisses;
    const cacheEfficiencyRatio = totalCacheOps > 0 ? this.cacheHits / totalCacheOps : 1.0;

    return {
      page_size: pageSize,
      page_count: pageCount,
      freelist_count: freelistCount,
      database_size_bytes: databaseSizeBytes,
      wal_size_bytes: walSizeBytes,
      episodes_count: episodesCount,
      vectors_count: vectorsCount,
      graph_edges_count: graphEdgesCount,
      cache_hit_count: this.cacheHits,
      cache_miss_count: this.cacheMisses,
      cache_efficiency_ratio: cacheEfficiencyRatio,
    };
  }

  close(): void {
    this.db.close();
  }
}
