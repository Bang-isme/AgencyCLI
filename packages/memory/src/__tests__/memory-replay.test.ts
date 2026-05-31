import { describe, it, expect } from "vitest";
import { getDb, closeAllDbs } from "../db.js";
import { EpisodicStore } from "../episodic-store.js";

describe("Event Sourcing & Replay Verification", () => {
  it("should record event logs and replay them to reconstruct matching state", () => {
    const backend = getDb(":memory:", ":memory:");
    const store = new EpisodicStore(backend);

    // Perform operations and log events
    store.addEpisode("session-1", "Goal A", 0, "run", "Content A");
    backend.logEvent("ADD_EPISODE", JSON.stringify({ sessionId: "session-1", goal: "Goal A", turnIndex: 0, content: "Content A" }));

    store.addEpisode("session-1", "Goal B", 1, "run", "Content B");
    backend.logEvent("ADD_EPISODE", JSON.stringify({ sessionId: "session-1", goal: "Goal B", turnIndex: 1, content: "Content B" }));

    // Verify events are logged sequentially
    const events = backend.getEvents(0);
    expect(events.length).toBe(2);
    expect(events[0]!.action).toBe("ADD_EPISODE");

    // Close and open a fresh database to simulate state reconstruction
    closeAllDbs();

    const freshBackend = getDb(":memory:", ":memory:");
    const freshStore = new EpisodicStore(freshBackend);

    // Replay mutations from the logged events list
    for (const event of events) {
      if (event.action === "ADD_EPISODE") {
        const payload = JSON.parse(event.payload);
        freshStore.addEpisode(payload.sessionId, payload.goal, payload.turnIndex, "run", payload.content);
      }
    }

    const replayedEpisodes = freshStore.getEpisodes("session-1");
    expect(replayedEpisodes.length).toBe(2);
    expect(replayedEpisodes[0]!.goal).toBe("Goal A");
    expect(replayedEpisodes[1]!.goal).toBe("Goal B");

    closeAllDbs();
  });
});
