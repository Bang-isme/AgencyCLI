import { describe, expect, it } from "vitest";
import { ActiveTelemetryTracker } from "../tracker.js";
import { ReplayEngine } from "../replay.js";

describe("packages/telemetry", () => {
  describe("TelemetryTracker & ActiveTelemetryTracker", () => {
    it("should start a session and record turns and tool outputs cleanly", () => {
      const tracker = new ActiveTelemetryTracker({
        initialGitHash: "abcdef",
        providerSeed: 42,
      });

      tracker.startSession("session-123", "Verify auth module safety");
      tracker.recordTurn(350);
      tracker.recordTurn(420);

      tracker.recordToolCall("bash", { command: "npm test" }, { exitCode: 0, stdout: "pass" });
      tracker.recordToolCall("read_file", { path: "src/auth.ts" }, { content: "export const auth = true;" });

      const trace = tracker.exportTrace();
      expect(trace.sessionId).toBe("session-123");
      expect(trace.goal).toBe("Verify auth module safety");
      expect(trace.initialGitHash).toBe("abcdef");
      expect(trace.providerSeed).toBe(42);
      expect(trace.timings).toEqual([350, 420]);
      expect(trace.toolOutputs).toHaveLength(2);
      
      expect(trace.toolOutputs[0]?.toolName).toBe("bash");
      expect(trace.toolOutputs[0]?.arguments).toEqual({ command: "npm test" });
      expect(trace.toolOutputs[0]?.output).toEqual({ exitCode: 0, stdout: "pass" });

      expect(trace.toolOutputs[1]?.toolName).toBe("read_file");
      expect(trace.toolOutputs[1]?.arguments).toEqual({ path: "src/auth.ts" });
    });
  });

  describe("ReplayEngine", () => {
    const sampleTrace = {
      sessionId: "session-abc",
      goal: "Run verification tests",
      timings: [250, 310],
      toolOutputs: [
        {
          toolName: "bash",
          arguments: { command: "echo yes" },
          output: { stdout: "yes" },
          timestamp: Date.now(),
        },
        {
          toolName: "bash",
          arguments: { command: "echo yes" }, // duplicate call signature
          output: { stdout: "yes-second" },
          timestamp: Date.now(),
        },
        {
          toolName: "write_file",
          arguments: { path: "output.txt", nested: { array: [1, 2], active: true } },
          output: { success: true },
          timestamp: Date.now(),
        },
      ],
    };

    it("should emulate virtual clock turn durations dynamically", () => {
      const replay = new ReplayEngine(sampleTrace);
      expect(replay.nextTurnDuration()).toBe(250);
      expect(replay.nextTurnDuration()).toBe(310);
      expect(replay.nextTurnDuration()).toBe(100); // baseline fallback
    });

    it("should deep-match tool arguments and resolve sequential duplicate entries", () => {
      const replay = new ReplayEngine(sampleTrace);
      expect(replay.getUnconsumedCount()).toBe(3);

      // Deep match nested parameters
      const firstWrite = replay.interceptToolCall("write_file", {
        path: "output.txt",
        nested: { active: true, array: [1, 2] }, // reordered keys should still deep-equal!
      });
      expect(firstWrite).toEqual({ success: true });
      expect(replay.getUnconsumedCount()).toBe(2);

      // Verify sequential duplicate inputs get solved in trace order
      const call1 = replay.interceptToolCall("bash", { command: "echo yes" });
      expect(call1).toEqual({ stdout: "yes" });

      const call2 = replay.interceptToolCall("bash", { command: "echo yes" });
      expect(call2).toEqual({ stdout: "yes-second" });

      expect(replay.getUnconsumedCount()).toBe(0);
    });

    it("should throw a descriptive deviation error if arguments differ or are unmatched", () => {
      const replay = new ReplayEngine(sampleTrace);
      expect(() => replay.interceptToolCall("bash", { command: "npm run start" })).toThrow(
        /\[Replay Deviation\] No matching recorded trace entry found for tool "bash" with arguments: {"command":"npm run start"}/
      );
    });
  });
});
