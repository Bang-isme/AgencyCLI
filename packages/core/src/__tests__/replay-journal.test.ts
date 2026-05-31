import { describe, expect, it, afterEach } from "vitest";
import { EventJournal } from "../events/event-journal.js";
import { ReplayEngine } from "../events/replay-engine.js";
import { ReplayEvent } from "@agency/contracts";
import { createHash } from "node:crypto";

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
