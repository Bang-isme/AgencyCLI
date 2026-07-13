import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { enterAlternateScreen, leaveAlternateScreen } from "../terminal/screen.js";

describe("Alternate Screen Lag Monitor", () => {
  let originalStdoutIsTTY: boolean | undefined;
  let originalStdoutWrite: typeof process.stdout.write;
  let originalStderrWrite: typeof process.stderr.write;

  beforeEach(() => {
    // Save original values
    originalStdoutIsTTY = process.stdout.isTTY;
    originalStdoutWrite = process.stdout.write;
    originalStderrWrite = process.stderr.write;

    // Force TTY to true so enterAlternateScreen doesn't exit early
    Object.defineProperty(process.stdout, "isTTY", {
      value: true,
      writable: true,
      configurable: true,
    });

    // Mock stdout/stderr write to prevent terminal garbage
    process.stdout.write = vi.fn().mockReturnValue(true) as any;
    process.stderr.write = vi.fn().mockReturnValue(true) as any;

    vi.spyOn(global, "setInterval");
    vi.spyOn(global, "clearInterval");
  });

  afterEach(() => {
    // Restore original values
    if (originalStdoutIsTTY !== undefined) {
      Object.defineProperty(process.stdout, "isTTY", {
        value: originalStdoutIsTTY,
        writable: true,
        configurable: true,
      });
    }
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;

    vi.restoreAllMocks();
  });

  it("creates, clears, and recreates lagInterval when entering/leaving alternate screen", () => {
    // 1. Enter alternate screen
    enterAlternateScreen();
    expect(setInterval).toHaveBeenCalledTimes(1);
    const firstTimer = (setInterval as any).mock.results[0].value;

    // 2. Exit alternate screen
    leaveAlternateScreen();
    expect(clearInterval).toHaveBeenCalledTimes(1);
    expect(clearInterval).toHaveBeenCalledWith(firstTimer);

    // 3. Re-enter alternate screen
    enterAlternateScreen();
    // It should recreate the setInterval!
    expect(setInterval).toHaveBeenCalledTimes(2);
    const secondTimer = (setInterval as any).mock.results[1].value;
    expect(secondTimer).not.toBe(firstTimer);

    // Clean up
    leaveAlternateScreen();
    expect(clearInterval).toHaveBeenCalledTimes(2);
  });
});
