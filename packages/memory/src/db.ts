import Database from "better-sqlite3";
import { resolve, dirname } from "node:path";
import { mkdirSync, existsSync, copyFileSync } from "node:fs";
import { SqliteStorageBackend } from "./storage-backend.js";
import { runMigrations } from "./migrations.js";

const connections = new Map<string, { db: any; backend: SqliteStorageBackend }>();

// Cleanly close all connections on process exit to avoid database locks
process.on("exit", () => {
  closeAllDbs();
});


export function getDb(projectRoot: string, dbPathOverride?: string): SqliteStorageBackend {
  const defaultPath = projectRoot === ":memory:" ? ":memory:" : resolve(projectRoot, ".agency/memory/memory.db");
  const targetPath = dbPathOverride === ":memory:" ? ":memory:" : (dbPathOverride ? resolve(dbPathOverride) : defaultPath);

  const cached = connections.get(targetPath);
  if (cached) {
    return cached.backend;
  }

  // Auto-create directories if they don't exist
  if (targetPath !== ":memory:") {
    const dir = dirname(targetPath);
    mkdirSync(dir, { recursive: true });
  }

  let db: any;
  const shadowPath = `${targetPath}.shadow`;

  const initDb = (path: string) => {
    const instance = new Database(path);
    instance.pragma("journal_mode = WAL");
    instance.pragma("synchronous = NORMAL");
    instance.pragma("busy_timeout = 5000");
    instance.pragma("temp_store = memory");
    instance.pragma("mmap_size = 268435456"); // 256MB mmap
    instance.pragma("cache_size = -64000"); // 64MB cache
    runMigrations(instance);
    return instance;
  };

  try {
    db = initDb(targetPath);
  } catch (err) {
    if (targetPath !== ":memory:" && existsSync(shadowPath)) {
      try {
        copyFileSync(shadowPath, targetPath);
        db = initDb(targetPath);
      } catch {
        throw err;
      }
    } else {
      throw err;
    }
  }

  const backend = new SqliteStorageBackend(db);
  connections.set(targetPath, { db, backend });
  return backend;
}

export function closeDb(projectRoot: string): void {
  const defaultPath = projectRoot === ":memory:" ? ":memory:" : resolve(projectRoot, ".agency/memory/memory.db");
  const cached = connections.get(defaultPath);
  if (cached) {
    connections.delete(defaultPath);
    try {
      cached.db.close();
    } catch {}
  }
}

export function closeAllDbs(): void {
  const snapshot = Array.from(connections.entries());
  connections.clear();
  for (const [, conn] of snapshot) {
    try {
      conn.db.close();
    } catch {
      // Ignore double close or similar errors during cleanup
    }
  }
}
