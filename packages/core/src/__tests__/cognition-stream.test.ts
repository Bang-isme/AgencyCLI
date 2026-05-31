import { describe, expect, it } from "vitest";
import { EventBus } from "../events/event-bus.js";
import { emitThought } from "../events/cognition.js";
import { RuntimeThoughtEvent } from "@agency/contracts";

describe("Runtime Cognition Stream & Events", () => {
  it("should successfully emit structured thought events onto the EventBus", async () => {
    const eventBus = EventBus.getInstance();
    eventBus.clear();

    const receivedEvents: RuntimeThoughtEvent[] = [];
    eventBus.subscribe("thought:emitted", (evt) => {
      const parsed = typeof evt.payload === "string" ? JSON.parse(evt.payload) : evt.payload;
      receivedEvents.push(parsed);
    });

    emitThought({
      source: "planner",
      phase: "planning",
      severity: "info",
      message: "Orchestrating code refactor sequence.",
      confidence: "high"
    });

    // Wait short moment for async callbacks
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(receivedEvents).toHaveLength(1);
    const event = receivedEvents[0]!;
    expect(event.source).toBe("planner");
    expect(event.phase).toBe("planning");
    expect(event.severity).toBe("info");
    expect(event.message).toBe("Orchestrating code refactor sequence.");
    expect(event.confidence).toBe("high");
    expect(event.id).toBeDefined();
    expect(event.timestamp).toBeLessThanOrEqual(Date.now());
  });
});
