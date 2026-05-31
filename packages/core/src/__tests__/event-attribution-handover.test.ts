import { describe, expect, it, afterEach, beforeEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventBus, type DurableEventSink } from "../events/event-bus.js";
import { EventJournal } from "../events/event-journal.js";
import { generateHandover } from "../runtime/handover.js";
import { saveCheckpoint } from "../task/checkpoint.js";
import { closeAllDbs } from "@agency/memory";
import type { ReplayEvent } from "@agency/contracts";

describe("event attribution", () => {
  const bus = EventBus.getInstance();
  afterEach(() => bus.clear());

  it("attaches agent/task/duration/cost meta to the published event + sink", async () => {
    const captured: ReplayEvent[] = [];
    const sink: DurableEventSink = { appendEvent: (e) => captured.push(e) };
    bus.attachDurableJournal(sink);

    await bus.publish("tool:executed", { name: "write_file" }, {
      agentId: "code-agent",
      taskId: "task-7",
      durationMs: 142,
      costUsd: 0.0031,
    });

    expect(captured).toHaveLength(1);
    const e = captured[0]!;
    expect(e.agentId).toBe("code-agent");
    expect(e.taskId).toBe("task-7");
    expect(e.durationMs).toBe(142);
    expect(e.costUsd).toBeCloseTo(0.0031, 6);
    bus.detachDurableJournal();
  });

  it("omits meta fields when not provided (legacy shape)", async () => {
    const captured: ReplayEvent[] = [];
    bus.attachDurableJournal({ appendEvent: (e) => captured.push(e) });
    await bus.publish("plain:event", { x: 1 });
    expect(captured[0]!.agentId).toBeUndefined();
    expect(captured[0]!.costUsd).toBeUndefined();
    bus.detachDurableJournal();
  });

  it("does not fold meta into the replay/dedup hash", async () => {
    // Same action+payload with different meta dedups (hash unchanged).
    const a = await bus.publish("dup:check", { v: 1 }, { agentId: "a" });
    const b = await bus.publish("dup:check", { v: 1 }, { agentId: "b" });
    expect(a).toBe(true);
    expect(b).toBe(false); // deduplicated despite different meta
  });
});

describe("EventJournal attribution round-trip", () => {
  it("persists and reads attribution columns; legacy rows omit them", () => {
    const j = new EventJournal(":memory:");
    j.appendEvent({
      sequenceId: 1, timestamp: 10, action: "a", payloadHash: "h1", payload: "{}",
      agentId: "x", taskId: "t1", durationMs: 5, costUsd: 0.5,
    });
    j.appendEvent({ sequenceId: 2, timestamp: 20, action: "b", payloadHash: "h2", payload: "{}" });

    const rows = j.readEvents();
    expect(rows).toHaveLength(2);
    expect(rows[0]!.agentId).toBe("x");
    expect(rows[0]!.taskId).toBe("t1");
    expect(rows[0]!.costUsd).toBe(0.5);
    expect(rows[1]!.agentId).toBeUndefined();
    expect(rows[1]!.costUsd).toBeUndefined();
    j.close();
  });
});

describe("generateHandover", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "agency-handover-"));
  });
  afterEach(() => {
    // getMemoryTelemetry (via getDb) caches an open SQLite connection; close it
    // before unlinking so Windows doesn't EBUSY on the still-open .db file.
    closeAllDbs();
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      // best-effort temp cleanup
    }
  });

  it("writes a handover.md summarizing active, completed, and blocked tasks", () => {
    saveCheckpoint(root, { id: "run-a", planPath: "p.md", currentTask: 3, completed: [1, 2], status: "running", updatedAt: "" });
    saveCheckpoint(root, { id: "pause-b", planPath: "p.md", currentTask: 1, completed: [], status: "paused", updatedAt: "" });
    saveCheckpoint(root, { id: "done-c", planPath: "p.md", currentTask: 5, completed: [1, 2, 3, 4, 5], status: "done", updatedAt: "" });

    const { markdown, path } = generateHandover(root, 1_700_000_000_000);

    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, "utf8")).toBe(markdown);
    expect(markdown).toContain("# AgencyCLI Session Handover");
    expect(markdown).toContain("Active / Resumable Tasks (2)");
    expect(markdown).toContain("run-a");
    expect(markdown).toContain("pause-b");
    expect(markdown).toContain("Completed Tasks (1)");
    expect(markdown).toContain("done-c");
    // Paused task surfaces as a blocker.
    expect(markdown).toContain("Blockers (1)");
    expect(markdown).toMatch(/pause-b.*paused/);
  });
});
