import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render } from "ink-testing-library";
import { useTick } from "../useTick.js";
import * as frameClock from "../frameClock.js";

let mockSubscribeCallCount = 0;
let mockUnsubscribeCallCount = 0;

vi.mock("../frameClock.js", () => {
  return {
    subscribeFrame: (intervalMs: number, onFrame: () => void) => {
      mockSubscribeCallCount++;
      return () => {
        mockUnsubscribeCallCount++;
      };
    },
    getFrame: (intervalMs: number) => 0,
  };
});

// Helper to flush asynchronous React/Ink layout effects and timers
const flushEffects = () => new Promise((resolve) => setTimeout(resolve, 20));

describe("useTick subscription stability", () => {
  beforeEach(() => {
    mockSubscribeCallCount = 0;
    mockUnsubscribeCallCount = 0;
    process.env.AGENCY_TUI_ANIMATIONS = "1"; // ensure animations enabled
  });

  afterEach(() => {
    delete process.env.AGENCY_TUI_ANIMATIONS;
  });

  it("does not churn subscriptions on re-renders when active and interval are unchanged", async () => {
    let renderCount = 0;
    const TestComponent = ({ dummy }: { dummy: number }) => {
      renderCount++;
      useTick(true, 100);
      return null;
    };

    const { rerender, unmount } = render(<TestComponent dummy={1} />);
    await flushEffects();
    expect(mockSubscribeCallCount).toBe(1);
    expect(mockUnsubscribeCallCount).toBe(0);

    // Rerender with a new prop to trigger a render cycle
    rerender(<TestComponent dummy={2} />);
    await flushEffects();
    expect(renderCount).toBe(2);
    // Subscription should not have churned!
    expect(mockSubscribeCallCount).toBe(1);
    expect(mockUnsubscribeCallCount).toBe(0);

    // Rerender again
    rerender(<TestComponent dummy={3} />);
    await flushEffects();
    expect(renderCount).toBe(3);
    expect(mockSubscribeCallCount).toBe(1);
    expect(mockUnsubscribeCallCount).toBe(0);

    // Unmount should unsubscribe
    unmount();
    await flushEffects();
    expect(mockUnsubscribeCallCount).toBe(1);
  });

  it("re-subscribes when intervalMs changes", async () => {
    const TestComponent = ({ interval }: { interval: number }) => {
      useTick(true, interval);
      return null;
    };

    const { rerender, unmount } = render(<TestComponent interval={100} />);
    await flushEffects();
    expect(mockSubscribeCallCount).toBe(1);
    expect(mockUnsubscribeCallCount).toBe(0);

    // Change intervalMs
    rerender(<TestComponent interval={200} />);
    await flushEffects();
    // Should unsubscribe from 100 and subscribe to 200
    expect(mockSubscribeCallCount).toBe(2);
    expect(mockUnsubscribeCallCount).toBe(1);

    unmount();
    await flushEffects();
    expect(mockUnsubscribeCallCount).toBe(2);
  });
});
