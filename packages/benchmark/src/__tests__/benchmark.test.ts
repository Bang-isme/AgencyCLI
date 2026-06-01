import { describe, expect, it, afterEach } from "vitest";
import { promises as fs, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  fileAnalysisTask,
  astSearchTask,
  runBenchmarkTask,
  runBenchmarkSuite,
  runRegressionReplay,
} from "../index.js";
import { DeterministicExecutionTrace } from "@agency/telemetry";

describe("Benchmark Harness & Regression Suite", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    tempDirs.length = 0;
  });

  function createTempProjectRoot(): string {
    const dir = mkdtempSync(join(tmpdir(), "agency-benchmark-test-"));
    tempDirs.push(dir);
    return dir;
  }

  describe("Benchmark Task Execution", () => {
    it("should successfully execute fileAnalysisTask in isolated workspace", async () => {
      const projectRoot = createTempProjectRoot();
      const result = await runBenchmarkTask(fileAnalysisTask, projectRoot);

      expect(result.taskId).toBe("file-analysis");
      expect(result.success).toBe(true);
      expect(result.error).toBeUndefined();
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
      expect(result.costUsd).toBe(0); // standard local run has 0 LLM cost
    });

    it("should successfully execute astSearchTask in isolated workspace", async () => {
      const projectRoot = createTempProjectRoot();
      const result = await runBenchmarkTask(astSearchTask, projectRoot);

      expect(result.taskId).toBe("ast-search");
      expect(result.success).toBe(true);
      expect(result.error).toBeUndefined();
    });

    it("should run a suite of benchmark tasks", async () => {
      const projectRoot = createTempProjectRoot();
      const results = await runBenchmarkSuite([fileAnalysisTask, astSearchTask], projectRoot);

      expect(results.length).toBe(2);
      expect(results[0].taskId).toBe("file-analysis");
      expect(results[0].success).toBe(true);
      expect(results[1].taskId).toBe("ast-search");
      expect(results[1].success).toBe(true);
    });
  });

  describe("Regression Trace Replay Suite", () => {
    const sampleTrace: DeterministicExecutionTrace = {
      sessionId: "test-session-123",
      goal: "Simulated test task",
      timings: [150, 200],
      toolOutputs: [
        {
          toolName: "view_file",
          arguments: { AbsolutePath: "/workspace/src/index.ts" },
          output: "export const x = 42;",
          timestamp: Date.now(),
        },
        {
          toolName: "write_to_file",
          arguments: { TargetFile: "/workspace/src/index.ts", CodeContent: "new content" },
          output: "Success",
          timestamp: Date.now(),
        },
      ],
    };

    it("should pass when simulated executor exactly matches trace behavior", async () => {
      const simulatedExecutor = async (engine: any) => {
        // 1. Consume timing for turn 1
        const duration1 = engine.nextTurnDuration();
        expect(duration1).toBe(150);

        // 2. Consume first tool call
        const out1 = engine.interceptToolCall("view_file", {
          AbsolutePath: "/workspace/src/index.ts",
        });
        expect(out1).toBe("export const x = 42;");

        // 3. Consume timing for turn 2
        const duration2 = engine.nextTurnDuration();
        expect(duration2).toBe(200);

        // 4. Consume second tool call
        const out2 = engine.interceptToolCall("write_to_file", {
          TargetFile: "/workspace/src/index.ts",
          CodeContent: "new content",
        });
        expect(out2).toBe("Success");
      };

      const result = await runRegressionReplay(sampleTrace, simulatedExecutor);
      expect(result.success).toBe(true);
      expect(result.turnsReplayed).toBe(2);
      expect(result.unconsumedOutputs).toBe(0);
      expect(result.error).toBeUndefined();
    });

    it("should fail when simulated executor misses a tool call", async () => {
      const simulatedExecutor = async (engine: any) => {
        engine.nextTurnDuration();
        engine.interceptToolCall("view_file", {
          AbsolutePath: "/workspace/src/index.ts",
        });
        // Skips the second tool call
      };

      const result = await runRegressionReplay(sampleTrace, simulatedExecutor);
      expect(result.success).toBe(false);
      expect(result.unconsumedOutputs).toBe(1);
      expect(result.error).toContain("1 recorded tool outputs were not consumed");
    });

    it("should fail when simulated executor calls a tool with wrong arguments", async () => {
      const simulatedExecutor = async (engine: any) => {
        engine.nextTurnDuration();
        engine.interceptToolCall("view_file", {
          AbsolutePath: "/workspace/src/other.ts", // mismatch
        });
      };

      const result = await runRegressionReplay(sampleTrace, simulatedExecutor);
      expect(result.success).toBe(false);
      expect(result.error).toContain("[Replay Deviation]");
    });

    // §2.5 — LLM completions are now part of a trace; the regression replay must
    // reproduce them in order too (a deterministic/seeded re-run should).
    const llmTrace: DeterministicExecutionTrace = {
      sessionId: "test-session-llm",
      goal: "two-step edit",
      timings: [120],
      toolOutputs: [
        { toolName: "view_file", arguments: { path: "a.ts" }, output: "x", timestamp: 1 },
      ],
      llmResponses: [
        { text: "<view_file><path>a.ts</path></view_file>", finishReason: "tool_calls", timestamp: 1 },
        { text: "done", finishReason: "stop", timestamp: 2 },
      ],
    };

    it("should pass when the executor reproduces tool calls AND LLM responses", async () => {
      const executor = async (engine: any) => {
        engine.nextTurnDuration();
        engine.interceptToolCall("view_file", { path: "a.ts" });
        engine.interceptLlmResponse("<view_file><path>a.ts</path></view_file>");
        engine.interceptLlmResponse("done");
      };
      const result = await runRegressionReplay(llmTrace, executor);
      expect(result.success).toBe(true);
      expect(result.unconsumedLlmResponses).toBe(0);
    });

    it("should fail when an LLM response is not reproduced", async () => {
      const executor = async (engine: any) => {
        engine.nextTurnDuration();
        engine.interceptToolCall("view_file", { path: "a.ts" });
        engine.interceptLlmResponse("<view_file><path>a.ts</path></view_file>");
        // skips the final "done" completion
      };
      const result = await runRegressionReplay(llmTrace, executor);
      expect(result.success).toBe(false);
      expect(result.unconsumedLlmResponses).toBe(1);
      expect(result.error).toContain("LLM responses were not reproduced");
    });

    it("should fail when an LLM response diverges from the recorded text", async () => {
      const executor = async (engine: any) => {
        engine.nextTurnDuration();
        engine.interceptToolCall("view_file", { path: "a.ts" });
        engine.interceptLlmResponse("a completely different first response");
      };
      const result = await runRegressionReplay(llmTrace, executor);
      expect(result.success).toBe(false);
      expect(result.error).toContain("[Replay Deviation]");
    });

    it("reports unconsumedLlmResponses: 0 for pre-§2.5 traces (no completions)", async () => {
      const executor = async (engine: any) => {
        engine.nextTurnDuration();
        engine.interceptToolCall("view_file", { AbsolutePath: "/workspace/src/index.ts" });
        engine.nextTurnDuration();
        engine.interceptToolCall("write_to_file", {
          TargetFile: "/workspace/src/index.ts",
          CodeContent: "new content",
        });
      };
      const result = await runRegressionReplay(sampleTrace, executor);
      expect(result.success).toBe(true);
      expect(result.unconsumedLlmResponses).toBe(0);
    });
  });
});
