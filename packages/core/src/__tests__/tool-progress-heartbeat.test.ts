import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Spy on the cognition producer directly so we test the heartbeat TIMER, not the
// cognitionStream gate (the `enabled` param is the gate at this layer).
vi.mock("../events/cognition.js", () => ({ emitThought: vi.fn() }));

import { emitThought } from "../events/cognition.js";
import { startToolProgressHeartbeat } from "../chat/turn-helpers.js";

const spy = vi.mocked(emitThought);

describe("§8.10 startToolProgressHeartbeat (in-tool progress)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    spy.mockClear();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("emits a periodic narration with an elapsed suffix while enabled, then stops on cleanup", () => {
    const stop = startToolProgressHeartbeat("grep_file", "grep_file: src/**", true, 1000);

    // No immediate tick — a sub-interval tool finishes before any heartbeat fires.
    expect(spy).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1000);
    expect(spy).toHaveBeenCalledTimes(1);
    // Reuses describeToolActivity (grep → "Searching <target>") + elapsed suffix.
    expect(spy.mock.calls[0]![0]!.message).toMatch(/Searching src\/\*\* \(1s\)/);
    expect(spy.mock.calls[0]![0]!.source).toBe("retrieval");

    vi.advanceTimersByTime(1000);
    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy.mock.calls[1]![0]!.message).toMatch(/\(2s\)/);

    stop();
    vi.advanceTimersByTime(5000);
    expect(spy).toHaveBeenCalledTimes(2); // no further ticks after stop()
  });

  it("enabled=false creates no timer (legacy byte-identical) and stop() is a safe no-op", () => {
    const stop = startToolProgressHeartbeat("read_file", "read_file: big.log", false, 1000);
    vi.advanceTimersByTime(10_000);
    expect(spy).not.toHaveBeenCalled();
    expect(() => stop()).not.toThrow();
  });
});
