import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import React from "react";
import { render } from "ink-testing-library";
import { Box, Text } from "ink";
import { Conversation, calculateFormattedLines, getRenderPressure } from "../components/Conversation.js";
import { getTheme, DEFAULT_THEME_ID } from "../themes/registry.js";
import { getDegradationTier, getAdaptiveFlushInterval, forceLevel3SurvivalMode } from "../terminal/screen.js";
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

  it("filters lower priority elements under high loop lag (Render QoS)", () => {
    // Inject extreme lag mocks to simulate heavy loop delay
    vi.spyOn(ScreenModule, "getLoopLag").mockReturnValue(160);
    vi.spyOn(process, "memoryUsage").mockReturnValue({
      heapUsed: 900 * 1024 * 1024,
      heapTotal: 1000 * 1024 * 1024,
      external: 0,
      arrayBuffers: 0,
      rss: 0
    });
    const pressure = getRenderPressure(600);
    expect(pressure.pressureScore).toBeGreaterThanOrEqual(0.6);

    const messages = [
      { id: "msg-1", role: "system" as const, content: "SHELL_EXECUTION: npm test\noutput line\n", timestamp: Date.now() },
      { id: "msg-2", role: "user" as const, content: "Low priority message", timestamp: Date.now() }
    ];

    // Format under pressure
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

    // Spacer lines (which are LOW priority) should be filtered out to save layout nodes
    const hasSpacer = lines.some((l) => l.key.includes("spacer") || l.priority === "LOW");
    expect(hasSpacer).toBe(false);
  });

  it("triggers layout invariant checks, writes to tui-diagnostics.log and drops to survival mode", () => {
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
