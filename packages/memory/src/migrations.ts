import type { Database } from "better-sqlite3";

export interface Migration {
  version: number;
  name: string;
  up(db: Database): void;
  down(db: Database): void;
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: "initial_schema",
    up(db: Database) {
      // Create episodes table
      db.prepare(`
        CREATE TABLE IF NOT EXISTS episodes (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          tenant_id TEXT NOT NULL DEFAULT 'default',
          workspace_id TEXT,
          project_id TEXT,
          session_id TEXT NOT NULL,
          agent_id TEXT,
          memory_type TEXT NOT NULL,
          state TEXT NOT NULL DEFAULT 'ACTIVE',
          goal TEXT NOT NULL,
          turn_index INTEGER NOT NULL,
          action_signature TEXT NOT NULL,
          content TEXT NOT NULL,
          metadata TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          expires_at INTEGER,
          is_archived INTEGER DEFAULT 0,
          confidence_score REAL,
          decay_factor REAL,
          lamport_timestamp INTEGER DEFAULT 0,
          source_file TEXT,
          source_type TEXT,
          origin_agent_id TEXT,
          origin_workflow_id TEXT,
          origin_git_commit TEXT,
          lineage_parent_id INTEGER
        )
      `).run();

      // Create indexes for episodes
      db.prepare(`CREATE INDEX IF NOT EXISTS idx_episodes_session ON episodes(session_id)`).run();
      db.prepare(`CREATE INDEX IF NOT EXISTS idx_episodes_created ON episodes(created_at)`).run();

      // Create FTS5 virtual table for goal/content search
      db.prepare(`
        CREATE VIRTUAL TABLE IF NOT EXISTS episodes_fts USING fts5(
          goal,
          content,
          content='episodes',
          content_rowid='id',
          tokenize="unicode61"
        )
      `).run();

      // Create triggers to sync FTS5 table with episodes
      db.prepare(`
        CREATE TRIGGER IF NOT EXISTS episodes_ai AFTER INSERT ON episodes BEGIN
          INSERT INTO episodes_fts(rowid, goal, content) VALUES (new.id, new.goal, new.content);
        END
      `).run();

      db.prepare(`
        CREATE TRIGGER IF NOT EXISTS episodes_ad AFTER DELETE ON episodes BEGIN
          INSERT INTO episodes_fts(episodes_fts, rowid, goal, content) VALUES('delete', old.id, old.goal, old.content);
        END
      `).run();

      db.prepare(`
        CREATE TRIGGER IF NOT EXISTS episodes_au AFTER UPDATE ON episodes BEGIN
          INSERT INTO episodes_fts(episodes_fts, rowid, goal, content) VALUES('delete', old.id, old.goal, old.content);
          INSERT INTO episodes_fts(rowid, goal, content) VALUES (new.id, new.goal, new.content);
        END
      `).run();

      // Create vectors table
      db.prepare(`
        CREATE TABLE IF NOT EXISTS vectors (
          id TEXT PRIMARY KEY,
          tenant_id TEXT NOT NULL DEFAULT 'default',
          workspace_id TEXT,
          project_id TEXT,
          session_id TEXT,
          agent_id TEXT,
          memory_type TEXT NOT NULL,
          state TEXT NOT NULL DEFAULT 'ACTIVE',
          vector TEXT NOT NULL,
          content TEXT NOT NULL,
          metadata TEXT NOT NULL,
          embedding_model TEXT,
          embedding_dimension INTEGER,
          embedding_version TEXT,
          file_path TEXT,
          symbol_type TEXT,
          git_revision TEXT,
          source_file TEXT,
          source_type TEXT,
          origin_agent_id TEXT,
          origin_workflow_id TEXT,
          origin_git_commit TEXT,
          lineage_parent_id TEXT,
          lamport_timestamp INTEGER DEFAULT 0
        )
      `).run();

      db.prepare(`CREATE INDEX IF NOT EXISTS idx_vectors_tenant ON vectors(tenant_id)`).run();

      // Create graph_edges table
      db.prepare(`
        CREATE TABLE IF NOT EXISTS graph_edges (
          source_id TEXT,
          target_id TEXT,
          relation_type TEXT,
          weight REAL,
          metadata TEXT,
          PRIMARY KEY (source_id, target_id, relation_type)
        )
      `).run();

      // Create event_log table
      db.prepare(`
        CREATE TABLE IF NOT EXISTS event_log (
          sequence_id INTEGER PRIMARY KEY AUTOINCREMENT,
          timestamp INTEGER,
          action TEXT,
          payload TEXT
        )
      `).run();

      // Create audit_log table
      db.prepare(`
        CREATE TABLE IF NOT EXISTS audit_log (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          record_id TEXT,
          table_name TEXT,
          actor TEXT,
          reason TEXT,
          mutation_type TEXT,
          pre_state TEXT,
          post_state TEXT,
          timestamp INTEGER
        )
      `).run();

      // Create quarantined_vectors table
      db.prepare(`
        CREATE TABLE IF NOT EXISTS quarantined_vectors (
          id TEXT,
          vector TEXT,
          error TEXT,
          quarantined_at INTEGER
        )
      `).run();
    },
    down(db: Database) {
      // Revert initial schema
      db.prepare(`DROP TRIGGER IF EXISTS episodes_au`).run();
      db.prepare(`DROP TRIGGER IF EXISTS episodes_ad`).run();
      db.prepare(`DROP TRIGGER IF EXISTS episodes_ai`).run();
      db.prepare(`DROP TABLE IF EXISTS episodes_fts`).run();
      db.prepare(`DROP TABLE IF EXISTS episodes`).run();
      db.prepare(`DROP TABLE IF EXISTS vectors`).run();
      db.prepare(`DROP TABLE IF EXISTS graph_edges`).run();
      db.prepare(`DROP TABLE IF EXISTS event_log`).run();
      db.prepare(`DROP TABLE IF EXISTS audit_log`).run();
      db.prepare(`DROP TABLE IF EXISTS quarantined_vectors`).run();
    },
  },
  {
    version: 2,
    name: "embedding_cache",
    up(db: Database) {
      db.prepare(`
        CREATE TABLE IF NOT EXISTS embedding_cache (
          text TEXT NOT NULL,
          embedding_model TEXT NOT NULL,
          vector TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          PRIMARY KEY (text, embedding_model)
        )
      `).run();
      db.prepare(`CREATE INDEX IF NOT EXISTS idx_embedding_cache_text ON embedding_cache(text)`).run();
    },
    down(db: Database) {
      db.prepare(`DROP INDEX IF EXISTS idx_embedding_cache_text`).run();
      db.prepare(`DROP TABLE IF EXISTS embedding_cache`).run();
    },
  },
];

export function runMigrations(db: Database): void {
  // Create schema_migrations table if it doesn't exist
  db.prepare(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at INTEGER NOT NULL
    )
  `).run();

  const userVersion = (db.prepare("PRAGMA user_version").get() as any).user_version;

  db.transaction(() => {
    for (const migration of MIGRATIONS) {
      if (migration.version > userVersion) {
        migration.up(db);
        db.prepare(`
          INSERT INTO schema_migrations (version, name, applied_at)
          VALUES (?, ?, ?)
        `).run(migration.version, migration.name, Date.now());

        db.pragma(`user_version = ${migration.version}`);
      }
    }
  })();
}

export function rollbackMigration(db: Database, targetVersion: number): void {
  const userVersion = (db.prepare("PRAGMA user_version").get() as any).user_version;

  db.transaction(() => {
    const sortedDesc = [...MIGRATIONS].sort((a, b) => b.version - a.version);
    for (const migration of sortedDesc) {
      if (migration.version <= userVersion && migration.version > targetVersion) {
        migration.down(db);
        db.prepare(`DELETE FROM schema_migrations WHERE version = ?`).run(migration.version);
        db.pragma(`user_version = ${migration.version - 1}`);
      }
    }
  })();
}
