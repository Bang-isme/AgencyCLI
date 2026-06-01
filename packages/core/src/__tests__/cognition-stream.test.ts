import { describe, expect, it, afterEach } from "vitest";
import { EventBus } from "../events/event-bus.js";
import { emitThought } from "../events/cognition.js";
import { RuntimeThoughtEvent } from "@agency/contracts";

describe("Runtime Cognition Stream & Events", () => {
  const prevEnv = { ...process.env };

  afterEach(() => {
    // restore env touched by the flag toggles
    process.env.AGENCY_COGNITION_STREAM = prevEnv.AGENCY_COGNITION_STREAM;
    process.env.AGENCY_PROFILE = prevEnv.AGENCY_PROFILE;
    if (prevEnv.AGENCY_COGNITION_STREAM === undefined) delete process.env.AGENCY_COGNITION_STREAM;
    if (prevEnv.AGENCY_PROFILE === undefined) delete process.env.AGENCY_PROFILE;
  });

  function collectThoughts(): RuntimeThoughtEvent[] {
    const eventBus = EventBus.getInstance();
    eventBus.clear();
    const received: RuntimeThoughtEvent[] = [];
    eventBus.subscribe("thought:emitted", (evt) => {
      const parsed = typeof evt.payload === "string" ? JSON.parse(evt.payload) : evt.payload;
      received.push(parsed);
    });
    return received;
  }

  it("emits structured thought events onto the EventBus when cognitionStream is on", async () => {
    process.env.AGENCY_COGNITION_STREAM = "1";
    const received = collectThoughts();

    emitThought({
      source: "planner",
      phase: "planning",
      severity: "info",
      message: "Orchestrating code refactor sequence.",
      confidence: "high",
    });

    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(received).toHaveLength(1);
    const event = received[0]!;
    expect(event.source).toBe("planner");
    expect(event.phase).toBe("planning");
    expect(event.severity).toBe("info");
    expect(event.message).toBe("Orchestrating code refactor sequence.");
    expect(event.confidence).toBe("high");
    expect(event.id).toBeDefined();
    expect(event.timestamp).toBeLessThanOrEqual(Date.now());
  });

  it("is a no-op (publishes nothing) when cognitionStream is off (legacy)", async () => {
    process.env.AGENCY_PROFILE = "legacy";
    process.env.AGENCY_COGNITION_STREAM = "0";
    const received = collectThoughts();

    emitThought({
      source: "risk-engine",
      phase: "editing",
      severity: "warning",
      message: "Safety: blocked write_file",
    });

    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(received).toHaveLength(0);
  });
});
