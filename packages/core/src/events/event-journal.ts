import Database from "better-sqlite3";
import { join, dirname } from "node:path";
import { mkdirSync } from "node:fs";
import { ReplayEvent } from "@agency/contracts";

const activeJournals = new Set<EventJournal>();

process.on("exit", () => {
  for (const journal of activeJournals) {
    try {
      journal.close();
    } catch {}
  }
  activeJournals.clear();
});

export class EventJournal {
  private db: Database.Database;

  constructor(projectRoot: string) {
    activeJournals.add(this);

    // If projectRoot is :memory:, use in-memory database for testing
    const dbPath = projectRoot === ":memory:" ? ":memory:" : join(projectRoot, ".agency", "events", "journal.db");
    if (dbPath !== ":memory:") {
      mkdirSync(dirname(dbPath), { recursive: true });
    }
    
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    
    // Create tables if they don't exist
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS events (
        sequence_id INTEGER PRIMARY KEY,
        timestamp INTEGER NOT NULL,
        action TEXT NOT NULL,
        payload_hash TEXT NOT NULL,
        payload TEXT NOT NULL,
        agent_id TEXT,
        task_id TEXT,
        duration_ms REAL,
        cost_usd REAL
      );
      CREATE TABLE IF NOT EXISTS checkpoints (
        state_name TEXT PRIMARY KEY,
        timestamp INTEGER NOT NULL,
        state_data TEXT NOT NULL
      );
    `);

    // Additive migration for journals created before the attribution columns
    // existed. ALTER fails if the column is already present — ignore that.
    for (const col of ["agent_id TEXT", "task_id TEXT", "duration_ms REAL", "cost_usd REAL"]) {
      try {
        this.db.exec(`ALTER TABLE events ADD COLUMN ${col}`);
      } catch {
        // column already exists
      }
    }
  }

  /**
   * Appends an event to the persistent SQLite journal.
   */
  public appendEvent(event: ReplayEvent): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO events (sequence_id, timestamp, action, payload_hash, payload, agent_id, task_id, duration_ms, cost_usd)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      event.sequenceId,
      event.timestamp,
      event.action,
      event.payloadHash,
      event.payload,
      event.agentId ?? null,
      event.taskId ?? null,
      event.durationMs ?? null,
      event.costUsd ?? null
    );
  }

  /**
   * Reads all events chronologically from the journal. Null attribution columns
   * are dropped so legacy events round-trip to the same shape.
   */
  public readEvents(): ReplayEvent[] {
    const stmt = this.db.prepare(`
      SELECT sequence_id as sequenceId, timestamp, action, payload_hash as payloadHash, payload,
             agent_id as agentId, task_id as taskId, duration_ms as durationMs, cost_usd as costUsd
      FROM events
      ORDER BY sequence_id ASC
    `);
    const rows = stmt.all() as Record<string, any>[];
    return rows.map((r) => {
      const e: ReplayEvent = {
        sequenceId: r.sequenceId,
        timestamp: r.timestamp,
        action: r.action,
        payloadHash: r.payloadHash,
        payload: r.payload,
      };
      if (r.agentId != null) e.agentId = r.agentId;
      if (r.taskId != null) e.taskId = r.taskId;
      if (r.durationMs != null) e.durationMs = r.durationMs;
      if (r.costUsd != null) e.costUsd = r.costUsd;
      return e;
    });
  }

  /**
   * Clears the event journal database.
   */
  public clearEvents(): void {
    this.db.exec("DELETE FROM events");
  }

  /**
   * Persists a checkpoint state to SQLite.
   */
  public saveCheckpoint(stateName: string, stateData: any): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO checkpoints (state_name, timestamp, state_data)
      VALUES (?, ?, ?)
    `);
    stmt.run(stateName, Date.now(), JSON.stringify(stateData));
  }

  /**
   * Loads a checkpoint state from SQLite.
   */
  public loadCheckpoint(stateName: string): any {
    const stmt = this.db.prepare(`
      SELECT state_data FROM checkpoints WHERE state_name = ?
    `);
    const row = stmt.get(stateName) as { state_data: string } | undefined;
    return row ? JSON.parse(row.state_data) : null;
  }

  /**
   * Closes the database connection.
   */
  public close(): void {
    activeJournals.delete(this);
    try {
      this.db.close();
    } catch {}
  }
}
