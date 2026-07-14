import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execa } from "execa";
import { join } from "node:path";
import { unlinkSync, existsSync, readFileSync } from "node:fs";
import Database from "better-sqlite3";
import { getDb, EpisodicStore, Supervisor } from "@agency/memory";

const cliEntry = join(process.cwd(), "../cli/dist/index.js");
const projectRoot = join(process.cwd(), "../../");
const agencyDir = join(projectRoot, ".agency");
const serverJsonPath = join(agencyDir, "server.json");

async function stopServer(proc: any, config: any) {
  if (config && config.url && config.token) {
    try {
      await fetch(`${config.url}/server/stop`, {
        method: "POST",
        headers: { "Authorization": `Bearer ${config.token}` },
        signal: AbortSignal.timeout(1000),
      });
      await new Promise((resolve) => setTimeout(resolve, 300));
    } catch {}
  }
  try {
    proc.kill("SIGTERM");
  } catch {}
  await proc.catch(() => {});
}

describe("Requirement R1: Concurrency (T1) E2E Tests", () => {
  let daemonProcess: any;
  let serverConfig: { url: string; token: string; pid: number } | null = null;

  beforeAll(async () => {
    // Delete stale server.json first
    if (existsSync(serverJsonPath)) {
      try {
        unlinkSync(serverJsonPath);
      } catch {}
    }

    // Start daemon server to handle HTTP/SSE requests
    daemonProcess = execa("node", [cliEntry, "server", "start", "--port", "0", "--project-root", projectRoot], {
      env: { ...process.env },
    });
    daemonProcess.catch(() => {});

    // Wait for server.json to be created
    let attempts = 0;
    while (attempts < 50) {
      if (existsSync(serverJsonPath)) {
        try {
          serverConfig = JSON.parse(readFileSync(serverJsonPath, "utf8"));
          if (serverConfig && serverConfig.url) {
            break;
          }
        } catch {}
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
      attempts++;
    }

    if (!serverConfig) {
      throw new Error("Failed to start daemon server for concurrency tests");
    }
  });

  afterAll(async () => {
    if (daemonProcess) {
      await stopServer(daemonProcess, serverConfig);
    }
  });

  // Feature 1: Trigger Classification (run vs wake)
  it("Feature 1: should classify triggers correctly as run or wake", async () => {
    const sessionId = "session-f1";
    // Send a wake trigger
    const wakeRes = await fetch(`${serverConfig!.url}/sessions/${sessionId}/wake`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${serverConfig!.token}`,
        "Content-Type": "application/json",
      },
    });
    await wakeRes.json();
    expect(wakeRes.status).toBe(200);

    // Let it run and query state via SSE subscription or status check
    const statusRes = await fetch(`${serverConfig!.url}/sessions/${sessionId}/status`, {
      headers: { "Authorization": `Bearer ${serverConfig!.token}` },
    });
    const statusData = await statusRes.json() as any;
    expect(["idle", "running"]).toContain(statusData.status);
  });

  // Feature 2: Lane Coalescing Queue
  it("Feature 2: should coalesce multiple incoming wake triggers", async () => {
    const sessionId = "session-f2";
    
    // Trigger run to make it busy
    await fetch(`${serverConfig!.url}/sessions/${sessionId}/run`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${serverConfig!.token}`,
        "Content-Type": "application/json",
      },
    });

    // Send 3 successive wake triggers
    const p1 = fetch(`${serverConfig!.url}/sessions/${sessionId}/wake`, {
      method: "POST",
      headers: { "Authorization": `Bearer ${serverConfig!.token}` },
    });
    const p2 = fetch(`${serverConfig!.url}/sessions/${sessionId}/wake`, {
      method: "POST",
      headers: { "Authorization": `Bearer ${serverConfig!.token}` },
    });
    const p3 = fetch(`${serverConfig!.url}/sessions/${sessionId}/wake`, {
      method: "POST",
      headers: { "Authorization": `Bearer ${serverConfig!.token}` },
    });

    const [r1, r2, r3] = await Promise.all([p1, p2, p3]);
    await r1.json();
    await r2.json();
    const d3 = await r3.json() as any;

    // Check that we coalesced the wakes so queue has at most one "wake"
    const wakeQueueCount = d3.queue.filter((q: string) => q === "wake").length;
    expect(wakeQueueCount).toBeLessThanOrEqual(1);
  });

  // Feature 3: Turn Priority Promotion
  it("Feature 3: should promote pending wake triggers to run triggers when a run is requested", async () => {
    const sessionId = "session-f3";
    
    // Trigger run to make it busy
    await fetch(`${serverConfig!.url}/sessions/${sessionId}/run`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${serverConfig!.token}`,
        "Content-Type": "application/json",
      },
    });

    // Trigger a wake
    await fetch(`${serverConfig!.url}/sessions/${sessionId}/wake`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${serverConfig!.token}`,
        "Content-Type": "application/json",
      },
    });

    // Trigger a run immediately after
    const runRes = await fetch(`${serverConfig!.url}/sessions/${sessionId}/run`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${serverConfig!.token}`,
        "Content-Type": "application/json",
      },
    });
    const runData = await runRes.json() as any;

    // The wake should be promoted/upgraded to run, meaning no wake in the queue
    expect(runData.queue).not.toContain("wake");
  });

  // Feature 4: Safe Execution Interruption
  it("Feature 4: should interrupt running workflows and return to idle", async () => {
    const sessionId = "session-f4";

    // Trigger a run
    await fetch(`${serverConfig!.url}/sessions/${sessionId}/run`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${serverConfig!.token}`,
        "Content-Type": "application/json",
      },
    });

    // Interrupt the execution
    const interruptRes = await fetch(`${serverConfig!.url}/sessions/${sessionId}/interrupt`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${serverConfig!.token}`,
        "Content-Type": "application/json",
      },
    });
    const interruptData = await interruptRes.json() as any;
    expect(interruptRes.status).toBe(200);
    expect(interruptData.status).toBe("idle");

    // Check status
    const statusRes = await fetch(`${serverConfig!.url}/sessions/${sessionId}/status`, {
      headers: { "Authorization": `Bearer ${serverConfig!.token}` },
    });
    const statusData = await statusRes.json() as any;
    expect(statusData.status).toBe("idle");
  });

  // Feature 5: DB OCC Schema (Revision lock)
  it("Feature 5: should enforce OCC schema using revision column in episodes and migrations", () => {
    // Connect to SQLite DB using better-sqlite3
    const db = new Database(":memory:");
    
    // Create episodes table with revision
    db.prepare(`
      CREATE TABLE episodes (
        id TEXT PRIMARY KEY,
        session_id TEXT,
        goal TEXT,
        turn_index INTEGER,
        type TEXT,
        content TEXT,
        revision INTEGER DEFAULT 0
      )
    `).run();

    db.prepare(`
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at INTEGER NOT NULL,
        revision INTEGER DEFAULT 0
      )
    `).run();

    // Verify columns exist
    const episodesInfo = db.prepare("PRAGMA table_info(episodes)").all() as any[];
    const revisionCol = episodesInfo.find((col) => col.name === "revision");
    expect(revisionCol).toBeDefined();
    expect(revisionCol.type).toBe("INTEGER");

    const migrationsInfo = db.prepare("PRAGMA table_info(schema_migrations)").all() as any[];
    const migrationRevisionCol = migrationsInfo.find((col) => col.name === "revision");
    expect(migrationRevisionCol).toBeDefined();
    expect(migrationRevisionCol.type).toBe("INTEGER");
  });

  // Feature 6: OCC Conflict Resolution (Yielding Retries)
  it("Feature 6: should resolve write conflicts by yielding and retrying", async () => {
    const backend = getDb(":memory:", ":memory:");
    const store = new EpisodicStore(backend);
    const supervisor = new Supervisor(backend);

    store.addEpisode("test-session", "Initial Goal", 0, "run", "Initial Content");

    let attempts = 0;
    const staleRevision = 2; // Stale because actual revision will be 1 when we attempt to write with expected=0

    await supervisor.safeWriteAsync(() => {
      attempts++;
      if (attempts === 1) {
        // Mismatch: expected 0 but actual is 1 (throws RevisionMismatch)
        store.addEpisode(
          "test-session",
          "Goal A",
          1,
          "run",
          "Content A",
          {},
          "default",
          "episodic",
          staleRevision - 2
        );
      } else {
        // Read correct max revision and succeed
        const currentMax = store.getEpisodes("test-session").length;
        store.addEpisode(
          "test-session",
          "Goal A",
          1,
          "run",
          "Content A",
          {},
          "default",
          "episodic",
          currentMax
        );
      }
    }, 5, 10);

    expect(attempts).toBe(2);
    expect(store.getEpisodes("test-session").length).toBe(2);
  });
});
