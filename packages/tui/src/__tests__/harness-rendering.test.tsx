import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import React from "react";
import { render } from "ink-testing-library";
import { Box, Text } from "ink";
import { Conversation, getRenderPressure, estimateNodeHeight } from "../components/Conversation.js";
import { getTheme, DEFAULT_THEME_ID } from "../themes/registry.js";
import { getAdaptiveFlushInterval, getLoopLag } from "../terminal/screen.js";

const theme = getTheme(DEFAULT_THEME_ID);

describe("Hardened TUI Terminal Renderer Tests", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("calculates node height precisely based on wrapping rules", () => {
    const testNode = (
      <Box flexDirection="column">
        <Text>Line 1 content</Text>
        <Text>Line 2 content</Text>
      </Box>
    );
    // Visual text is "Line 1 contentLine 2 content" (28 characters)
    // Wrapped in columns of width 10, it takes 3 lines:
    // "Line 1 con", "tentLine 2", " content" -> 3 lines
    const height = estimateNodeHeight(testNode, 10);
    expect(height).toBe(3);
  });

  it("applies Render QoS filters under high loop lag", () => {
    // Inject extreme lag to force high pressure score
    const spy = vi.spyOn(process, "memoryUsage").mockReturnValue({
      heapUsed: 900 * 1024 * 1024,
      heapTotal: 1000 * 1024 * 1024,
      external: 0,
      arrayBuffers: 0,
      rss: 0
    });

    const pressure = getRenderPressure(600);
    expect(pressure.isMemoryStressed).toBe(true);
    expect(pressure.pressureScore).toBeGreaterThanOrEqual(0.6);
  });

  it("handles viewport virtualization for long lists of elements", () => {
    const messages = Array.from({ length: 200 }, (_, i) => ({
      id: `msg-${i}`,
      role: "user" as const,
      content: `Item index ${i}`,
      timestamp: Date.now()
    }));

    const { lastFrame } = render(
      <Conversation
        theme={theme}
        messages={messages}
        viewportHeight={10}
        scrollOffset={10}
        cols={80}
      />
    );

    const frame = lastFrame();
    // Since viewportHeight is 10, it must only show a subset of elements, not all 200.
    expect(frame).not.toContain("Item index 0");
    expect(frame).not.toContain("Item index 199");
  });

  it("triggers layout-free survival mode fallback under heavy event queue pressure", () => {
    const messages = Array.from({ length: 15000 }, (_, i) => ({
      id: `msg-${i}`,
      role: "user" as const,
      content: `Item index ${i}`,
      timestamp: Date.now()
    }));

    const { lastFrame } = render(
      <Conversation
        theme={theme}
        messages={messages}
        viewportHeight={20}
        cols={80}
      />
    );

    const frame = lastFrame();
    expect(frame).toContain("SYSTEM IN SURVIVAL MODE");
    // Should show only the tail end (last 15 messages)
    expect(frame).toContain("Item index 14999");
  });

  it("calculates adaptive flush intervals based on process pressure", () => {
    const flushInterval = getAdaptiveFlushInterval();
    // Platform-dependent default (50ms on win32)
    if (process.platform === "win32") {
      expect(flushInterval).toBe(50);
    } else {
      expect(flushInterval).toBe(16);
    }
  });
});
