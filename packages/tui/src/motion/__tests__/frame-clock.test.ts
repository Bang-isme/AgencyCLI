import { afterEach, describe, expect, it, vi } from "vitest";
import {
  __resetFrameClock,
  __tickFrameClock,
  frameMultiplier,
  getFrame,
  subscribeFrame,
} from "../frameClock.js";

afterEach(() => {
  __resetFrameClock();
});

describe("frameMultiplier", () => {
  it("runs at full rate with no lag in the main phase", () => {
    expect(frameMultiplier(0, "main")).toBe(1);
    expect(frameMultiplier(40, "main")).toBe(1);
  });

  it("throttles progressively as event-loop lag rises", () => {
    expect(frameMultiplier(60, "main")).toBe(2);
    expect(frameMultiplier(120, "main")).toBe(4);
    expect(frameMultiplier(250, "main")).toBe(10);
  });

  it("never throttles outside the steady-state main phase", () => {
    expect(frameMultiplier(250, "splash")).toBe(1);
    expect(frameMultiplier(250, "welcome")).toBe(1);
  });
});

describe("frame clock buckets", () => {
  it("advances a cadence only after its interval elapses", () => {
    const onFrame = vi.fn();
    subscribeFrame(100, onFrame);

    __tickFrameClock(50); // half an interval — should not advance
    expect(getFrame(100)).toBe(0);
    expect(onFrame).not.toHaveBeenCalled();

    __tickFrameClock(100); // a full interval — should advance once
    expect(getFrame(100)).toBe(1);
    expect(onFrame).toHaveBeenCalledTimes(1);
  });

  it("keeps independent counters per cadence under one clock", () => {
    subscribeFrame(50, () => {});
    subscribeFrame(120, () => {});

    __tickFrameClock(60); // crosses 50 but not 120
    expect(getFrame(50)).toBe(1);
    expect(getFrame(120)).toBe(0);

    __tickFrameClock(130); // crosses both
    expect(getFrame(50)).toBe(2);
    expect(getFrame(120)).toBe(1);
  });

  it("stops notifying a cadence after the last subscriber leaves", () => {
    const onFrame = vi.fn();
    const unsubscribe = subscribeFrame(40, onFrame);

    __tickFrameClock(40);
    expect(onFrame).toHaveBeenCalledTimes(1);

    unsubscribe();
    __tickFrameClock(40);
    expect(onFrame).toHaveBeenCalledTimes(1); // no further callbacks
  });
});
