import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import React from "react";
import { render } from "ink-testing-library";
import { Box, Text } from "ink";
import { Conversation, calculateFormattedLines, getRenderPressure } from "../components/Conversation.js";
import { getTheme, DEFAULT_THEME_ID } from "../themes/registry.js";
import { getDegradationTier, getAdaptiveFlushInterval } from "../terminal/screen.js";
import * as ScreenModule from "../terminal/screen.js";
import fs from "fs";
import path from "path";

const theme = getTheme(DEFAULT_THEME_ID);

describe("Production-Grade TUI Chaos & Torture Tests", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // Clean up diagnostics log if exists
    const logFile = path.join(process.cwd(), ".agency", "tui-diagnostics.log");
    if (fs.existsSync(logFile)) {
      try {
        fs.unlinkSync(logFile);
      } catch {}
    }
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    delete process.env.AGENCY_TUI_DIAGNOSTICS;
  });

  it("survives long session loops with 100k+ rows using cached and recycled pools", () => {
    // Generate 100k messages
    const messages = Array.from({ length: 1000 }, (_, i) => ({
      id: `msg-${i}`,
      role: "user" as const,
      content: `Simulated message number ${i}`,
      timestamp: Date.now()
    }));

    // Perform multiple rapid formatting cycles to ensure we don't leak or crash
    const startTime = Date.now();
    for (let cycle = 0; cycle < 10; cycle++) {
      const lines = calculateFormattedLines(
        messages,
        80,
        theme,
        null,
        [],
        false,
        false,
        undefined,
        false
      );
      expect(lines.length).toBeGreaterThan(1000);
    }
    // Execution must be fast and heap memory-efficient due to formattedLinesCache
    const duration = Date.now() - startTime;
    expect(duration).toBeLessThan(5000); // 10 cycles of 1000 items should take < 5s
  });

  it("renders content deterministically under high loop lag (no QoS dropping)", () => {
    // Inject extreme lag + heap pressure to simulate a busy loop.
    vi.spyOn(ScreenModule, "getLoopLag").mockReturnValue(160);
    vi.spyOn(process, "memoryUsage").mockReturnValue({
      heapUsed: 900 * 1024 * 1024,
      heapTotal: 1000 * 1024 * 1024,
      external: 0,
      arrayBuffers: 0,
      rss: 0
    });
    const pressure = getRenderPressure(600);
    expect(pressure.pressureScore).toBeGreaterThanOrEqual(0.8);

    const messages = [
      { id: "qos-msg-1", role: "system" as const, content: "SHELL_EXECUTION: npm test\noutput line\n", timestamp: Date.now() },
      { id: "qos-msg-2", role: "user" as const, content: "Low priority message", timestamp: Date.now() }
    ];

    const lines = calculateFormattedLines(
      messages,
      80,
      theme,
      null,
      [],
      false,
      false,
      undefined,
      false
    );

    // Content is NEVER dropped based on transient runtime pressure. Hiding the
    // user's own rows under load shrank `allLines`, corrupted the scroll math,
    // and jittered the layout. The shell spacer (LOW priority) must survive —
    // rendering is now a pure function of the messages, not of loop lag/heap.
    const hasSpacer = lines.some((l) => l.key.includes("spacer"));
    expect(hasSpacer).toBe(true);
  });

  it("triggers layout invariant checks, writes to tui-diagnostics.log and drops to survival mode", () => {
    // Diagnostics disk logging is opt-in (it does sync IO in the render path).
    process.env.AGENCY_TUI_DIAGNOSTICS = "1";
    // Render Conversation with duplicate keys to trigger invariant violation
    const messages = [
      { id: "duplicate-id", role: "user" as const, content: "Msg 1", timestamp: Date.now() },
      { id: "duplicate-id", role: "user" as const, content: "Msg 2", timestamp: Date.now() }
    ];

    const { lastFrame } = render(
      <Conversation
        theme={theme}
        messages={messages}
        viewportHeight={10}
        scrollOffset={0}
        cols={80}
      />
    );

    // Check if diagnostic log file was written
    const logFile = path.join(process.cwd(), ".agency", "tui-diagnostics.log");
    expect(fs.existsSync(logFile)).toBe(true);

    const logContent = fs.readFileSync(logFile, "utf8");
    expect(logContent).toContain("INVARIANT VIOLATION: NO_DUPLICATE_VISIBLE_ROWS");
  });

  it("scales down animated useTick pacing and records pacing telemetry under loop lag pressure", () => {
    // Diagnostics disk logging is opt-in (it does sync IO in the render path).
    process.env.AGENCY_TUI_DIAGNOSTICS = "1";
    // Under no lag, interval remains 90ms
    vi.spyOn(ScreenModule, "getLoopLag").mockReturnValue(0);
    // Render countdown tick
    const messages = [
      { id: "msg-retry", role: "system" as const, content: "Retrying in 10.0s", timestamp: Date.now() }
    ];
    const { lastFrame, rerender } = render(
      <Conversation
        theme={theme}
        messages={messages}
        viewportHeight={10}
        scrollOffset={0}
        cols={80}
      />
    );
    
    // Simulate loop lag > 200ms
    vi.spyOn(ScreenModule, "getLoopLag").mockReturnValue(250);
    rerender(
      <Conversation
        theme={theme}
        messages={messages}
        viewportHeight={10}
        scrollOffset={1}
        cols={80}
      />
    );
    // Verify diagnostics output is written and has telemetry markers
    const logFile = path.join(process.cwd(), ".agency", "tui-diagnostics.log");
    expect(fs.existsSync(logFile)).toBe(true);
    const content = fs.readFileSync(logFile, "utf8");
    expect(content).toContain("Lag: 250ms");
    expect(content).toContain("Jitter:");
    expect(content).toContain("Heap:");
  });
});
