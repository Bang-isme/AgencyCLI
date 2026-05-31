import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { runMigrations, rollbackMigration } from "../migrations.js";

describe("Database Migration Verification", () => {
  it("should initialize schema to version 1 forward and roll back cleanly", () => {
    const db = new Database(":memory:");
    
    // Run forward migrations
    runMigrations(db);
    
    let userVersion = (db.prepare("PRAGMA user_version").get() as any).user_version;
    expect(userVersion).toBe(2);

    // Verify initial tables are created
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as any[];
    const tableNames = tables.map(t => t.name);
    
    expect(tableNames.includes("episodes")).toBe(true);
    expect(tableNames.includes("vectors")).toBe(true);
    expect(tableNames.includes("embedding_cache")).toBe(true);
    expect(tableNames.includes("schema_migrations")).toBe(true);

    // Run rollback migration back to version 0
    rollbackMigration(db, 0);

    userVersion = (db.prepare("PRAGMA user_version").get() as any).user_version;
    expect(userVersion).toBe(0);

    // Verify initial tables are dropped
    const rolledBackTables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as any[];
    const rolledBackNames = rolledBackTables.map(t => t.name);

    expect(rolledBackNames.includes("episodes")).toBe(false);
    expect(rolledBackNames.includes("vectors")).toBe(false);
    expect(rolledBackNames.includes("embedding_cache")).toBe(false);
    
    db.close();
  });
});
