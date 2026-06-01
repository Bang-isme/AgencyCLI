import { describe, expect, it, afterEach } from "vitest";
import { EventJournal } from "../events/event-journal.js";
import {
  ReplayEngine,
  verifyJournalReplay,
  replaySessionJournal,
} from "../events/replay-engine.js";
import { ReplayEvent } from "@agency/contracts";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("Event Journal & Replay Subsystem", () => {
  let journal: EventJournal | null = null;

  afterEach(() => {
    if (journal) {
      journal.close();
      journal = null;
    }
  });

  it("should persist events and checkpoints to SQLite and retrieve them chronologically", () => {
    journal = new EventJournal(":memory:");

    const evt1: ReplayEvent = {
      sequenceId: 1,
      timestamp: Date.now(),
      action: "test:action:1",
      payloadHash: "hash1",
      payload: JSON.stringify({ a: 1 }),
    };

    const evt2: ReplayEvent = {
      sequenceId: 2,
      timestamp: Date.now(),
      action: "test:action:2",
      payloadHash: "hash2",
      payload: JSON.stringify({ b: 2 }),
    };

    journal.appendEvent(evt2); // Out of order insert
    journal.appendEvent(evt1);

    const events = journal.readEvents();
    expect(events).toHaveLength(2);
    expect(events[0].sequenceId).toBe(1); // Chronologically ordered by sequence ID
    expect(events[1].sequenceId).toBe(2);

    // Checkpoint
    journal.saveCheckpoint("test-state", { value: 100 });
    const checkpoint = journal.loadCheckpoint("test-state");
    expect(checkpoint).toEqual({ value: 100 });
  });

  it("should match events and parameters hash deterministically in ReplayEngine", () => {
    const payload = { id: 1 };
    const payloadStr = JSON.stringify(payload);
    const hash = createHash("sha256").update("task:run:" + payloadStr).digest("hex");

    const events: ReplayEvent[] = [
      {
        sequenceId: 1,
        timestamp: Date.now(),
        action: "task:run",
        payloadHash: hash,
        payload: payloadStr,
      },
    ];

    const engine = new ReplayEngine(events);

    expect(engine.isComplete()).toBe(false);

    // Correct playback
    const matched = engine.playback("task:run", payload);
    expect(matched.sequenceId).toBe(1);
    expect(engine.isComplete()).toBe(true);
  });

  it("should throw errors on action mismatch or payload hash drift", () => {
    const payload = { id: 1 };
    const payloadStr = JSON.stringify(payload);
    const hash = createHash("sha256").update("task:run:" + payloadStr).digest("hex");

    const events: ReplayEvent[] = [
      {
        sequenceId: 1,
        timestamp: Date.now(),
        action: "task:run",
        payloadHash: hash,
        payload: payloadStr,
      },
    ];

    const engine = new ReplayEngine(events);

    // 1. Action mismatch
    expect(() => engine.playback("other:action", { id: 1 })).toThrow(/Replay mismatch/);

    const engine2 = new ReplayEngine(events);
    // 2. Parameter drift (different id)
    expect(() => engine2.playback("task:run", { id: 2 })).toThrow(/Replay divergence/);
  });
});

describe("verifyJournalReplay + replaySessionJournal (§2.5 behaviour-replay foundation)", () => {
  const mkEvent = (
    sequenceId: number,
    action: string,
    payloadObj: unknown,
  ): ReplayEvent => {
    const payload = JSON.stringify(payloadObj);
    return {
      sequenceId,
      timestamp: 1000 + sequenceId,
      action,
      payloadHash: createHash("sha256").update(action + ":" + payload).digest("hex"),
      payload,
    };
  };

  it("verifies a clean journal regardless of input order", () => {
    const res = verifyJournalReplay([
      mkEvent(2, "task:run", { id: 2 }),
      mkEvent(1, "task:start", { id: 1 }),
    ]);
    expect(res.ok).toBe(true);
    expect(res.total).toBe(2);
    expect(res.verified).toBe(2);
    expect(res.skipped).toBe(0);
  });

  it("flags the first divergence when a payload no longer matches its stored hash", () => {
    const good = mkEvent(1, "task:start", { id: 1 });
    // Tamper: keep the stale hash but mutate the payload (on-disk corruption).
    const tampered: ReplayEvent = {
      ...mkEvent(2, "task:run", { id: 2 }),
      payload: JSON.stringify({ id: 999 }),
    };
    const res = verifyJournalReplay([good, tampered]);
    expect(res.ok).toBe(false);
    expect(res.verified).toBe(1);
    expect(res.divergence?.sequenceId).toBe(2);
    expect(res.divergence?.action).toBe("task:run");
    expect(res.divergence?.reason).toMatch(/divergence|mismatch/i);
  });

  it("skips spilled oversized events instead of falsely flagging them", () => {
    const inline = mkEvent(1, "task:start", { id: 1 });
    const spilled: ReplayEvent = {
      sequenceId: 2,
      timestamp: 1002,
      action: "subagent:progress",
      // Hash covers the original payload, not this ref — must NOT be re-verified.
      payloadHash: "hash-of-the-original-not-the-ref",
      payload: JSON.stringify({
        refId: "ref-abc1234-9",
        summary: "Truncated large payload. Original size: 99999 bytes.",
      }),
    };
    const res = verifyJournalReplay([inline, spilled]);
    expect(res.ok).toBe(true);
    expect(res.verified).toBe(1);
    expect(res.skipped).toBe(1);
    expect(res.total).toBe(2);
  });

  it("treats an empty journal as vacuously ok", () => {
    expect(verifyJournalReplay([])).toMatchObject({
      ok: true,
      total: 0,
      verified: 0,
      skipped: 0,
    });
  });

  it("replaySessionJournal returns noJournal (and creates no DB) when none exists", () => {
    const dir = mkdtempSync(join(tmpdir(), "agency-replay-none-"));
    try {
      const res = replaySessionJournal(dir);
      expect(res.noJournal).toBe(true);
      expect(res.ok).toBe(true);
      expect(existsSync(join(dir, ".agency", "events", "journal.db"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("replaySessionJournal verifies a real on-disk journal", () => {
    const dir = mkdtempSync(join(tmpdir(), "agency-replay-ok-"));
    let j: EventJournal | null = new EventJournal(dir);
    try {
      j.appendEvent(mkEvent(1, "task:start", { id: 1 }));
      j.appendEvent(mkEvent(2, "task:run", { id: 2 }));
      j.close();
      j = null;
      const res = replaySessionJournal(dir);
      expect(res.ok).toBe(true);
      expect(res.total).toBe(2);
      expect(res.verified).toBe(2);
    } finally {
      if (j) j.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
