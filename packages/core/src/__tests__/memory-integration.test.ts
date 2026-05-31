import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDb, closeAllDbs } from "@agency/memory";
import { loadHistoricalMemories, safeAddEpisode } from "../chat/memory-integration.js";
import { EventBus } from "../events/event-bus.js";

describe("Phase 1: Persistent SQLite Memory Integration Tests", () => {
  let tempProjectRoot: string;

  beforeEach(() => {
    tempProjectRoot = mkdtempSync(join(tmpdir(), "agency-memory-test-"));
  });

  afterEach(() => {
    closeAllDbs();
    if (existsSync(tempProjectRoot)) {
      rmSync(tempProjectRoot, { recursive: true, force: true });
    }
  });

  it("should persist episodes to memory.db and perform cross-session query matching via FTS5", async () => {
    const sessionA = "sess-a";
    const sessionB = "sess-b";

    // 1. Ingest past memories in Session A
    safeAddEpisode(
      tempProjectRoot,
      sessionA,
      "Create native sandbox isolation features",
      0,
      "user_input",
      "I want to implement a secure native sandbox jail"
    );

    safeAddEpisode(
      tempProjectRoot,
      sessionA,
      "Create native sandbox isolation features",
      1,
      "tool_call:write_file",
      "Success: File written successfully to packages/core/src/terminal/sandbox.ts"
    );

    safeAddEpisode(
      tempProjectRoot,
      sessionA,
      "Create native sandbox isolation features",
      2,
      "assistant_reply",
      "I have completed writing the sandbox.ts wrapper using ProcessJail."
    );

    // 2. Query memories from Session B (simulating a brand new session context)
    // Querying for "sandbox" should retrieve the FTS match from Session A
    const memoryBlock = await loadHistoricalMemories(tempProjectRoot, "We need to fix the sandbox commands", sessionB);

    expect(memoryBlock).toContain("relevant past activities");
    expect(memoryBlock).toContain("Create native sandbox isolation features");
    expect(memoryBlock).toContain("tool_call:write_file");
    expect(memoryBlock).toContain("packages/core/src/terminal/sandbox.ts");
    expect(memoryBlock).toContain("assistant_reply");
    expect(memoryBlock).not.toContain(sessionB); // Should exclude Session B since we filtered for session_id != sessionB
  });

  it("should retrieve chronological recent past episodes even if they do not match keywords", async () => {
    const sessionA = "sess-a";
    const sessionB = "sess-b";

    // Ingest some generic unrelated episode in Session A
    safeAddEpisode(
      tempProjectRoot,
      sessionA,
      "Do some random compilation check",
      0,
      "execute_command",
      "tsc -p tsconfig.json output: success"
    );

    // Query with a totally different topic "auth tests"
    const memoryBlock = await loadHistoricalMemories(tempProjectRoot, "run auth tests", sessionB);

    // Should still retrieve the random compilation check because of chronological recency fallback
    expect(memoryBlock).toContain("Do some random compilation check");
    expect(memoryBlock).toContain("execute_command");
    expect(memoryBlock).toContain("tsc -p tsconfig.json");
  });

  it("should keep SQLite memories persistent even if JSON session log files are deleted", async () => {
    const sessionA = "sess-a";
    const sessionB = "sess-b";

    // 1. Simulate creating a JSON session file on disk under .agency/sessions/
    const sessionsDir = join(tempProjectRoot, ".agency", "sessions");
    const fs = require("node:fs");
    fs.mkdirSync(sessionsDir, { recursive: true });
    const jsonSessionFile = join(sessionsDir, `${sessionA}.json`);
    writeFileSync(jsonSessionFile, JSON.stringify({ id: sessionA, messages: [] }));
    expect(existsSync(jsonSessionFile)).toBe(true);

    // 2. Save episodes to SQLite DB
    safeAddEpisode(
      tempProjectRoot,
      sessionA,
      "Configure cost governance",
      0,
      "user_input",
      "Setup cost ceiling to $10.0"
    );

    // 3. Simulate session deletion by deleting the JSON session file
    rmSync(jsonSessionFile);
    expect(existsSync(jsonSessionFile)).toBe(false);

    // 4. Query from a new session: SQLite DB still contains the episodes because they are not deleted!
    const memoryBlock = await loadHistoricalMemories(tempProjectRoot, "cost budget", sessionB);
    expect(memoryBlock).toContain("Configure cost governance");
    expect(memoryBlock).toContain("Setup cost ceiling to $10.0");
  });

  // EventBus delivers to subscribers asynchronously (scheduleDrain → setImmediate),
  // so the assertion awaits a tick. Warnings are filtered by the unique session id
  // in the payload because the bus is a process-wide singleton shared across tests.
  it("surfaces a system:warning (not silent) when an episode write fails", async () => {
    const sessionId = "sess-write-fail";

    // Force the cached backend's next write to throw, simulating disk/DB failure.
    const backend = getDb(tempProjectRoot);
    (backend as any).simulateEnfile = true;

    const warnings: any[] = [];
    EventBus.getInstance().subscribe("system:warning", (e) => warnings.push(e));

    // A failed persist must NOT crash the chat flow — it stays a no-throw call...
    expect(() =>
      safeAddEpisode(tempProjectRoot, sessionId, "goal", 7, "user_input", "content")
    ).not.toThrow();

    // ...but the dropped episode must be observable, not silently lost.
    await new Promise((resolve) => setImmediate(resolve));
    const mine = warnings.filter((e) => String(e?.payload ?? "").includes(sessionId));
    expect(mine.length).toBeGreaterThan(0);
  });
});
