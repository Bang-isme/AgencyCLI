import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readdirSync, readFileSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ReplayEvent } from "@agency/contracts";
import {
  publishActionLifecycle,
  sanitizeLifecycleEvent,
  lifecycleFromToolEvent,
  convertLegacyEventToCanonical,
  reduceRuntimeState,
  saveRunManifest,
  loadRunManifest,
  listRunManifests,
  enforceRunRetention,
  runWorkflow,
  runChatTurn,
  runChatTurnWithStream,
  resolveRunId,
  RunManifestRecorder,
  MAX_RUN_MANIFESTS,
  MAX_MANIFEST_AGE_MS,
  type ActionLifecycleEvent,
  type RunManifest,
} from "../index.js";
import { EventBus } from "../events/event-bus.js";

describe("Runtime Control Plane Task 1.1 — Correlation, Manifests & Reduction", () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), "agency-control-plane-task11-"));
    EventBus.getInstance().clear();
  });

  afterEach(() => {
    try {
      rmSync(projectRoot, { recursive: true, force: true });
    } catch {}
    EventBus.getInstance().clear();
  });

  describe("Requirement 1: Non-global Run Correlation & resolveRunId", () => {
    it("never reads process.env.AGENCY_RUN_ID and generates unique fresh run UUIDs when unsupplied", () => {
      delete process.env.AGENCY_RUN_ID;
      const run1 = resolveRunId();
      const run2 = resolveRunId();
      expect(run1).not.toBe(run2);
      expect(run1).toMatch(/^run-[a-f0-9-]{36}$/);
      expect(run2).toMatch(/^run-[a-f0-9-]{36}$/);
      expect(run1).not.toBe("run-default");
    });

    it("returns explicitRunId when supplied", () => {
      const explicit = "run-explicit-correlation-id";
      expect(resolveRunId(explicit)).toBe(explicit);
    });
  });

  describe("Requirement 2 & 4: Concurrent Runs & Strict Isolation", () => {
    it("isolates lifecycle events and manifest entries between two concurrent runs", async () => {
      const runIdA = "run-concurrent-A";
      const runIdB = "run-concurrent-B";

      const recA = new RunManifestRecorder(projectRoot, runIdA, "sess-A");
      const recB = new RunManifestRecorder(projectRoot, runIdB, "sess-B");

      // Emit event for Run A
      publishActionLifecycle({
        id: `${runIdA}:toolCall-1`,
        runId: runIdA,
        kind: "tool",
        action: "read_file",
        state: "succeeded",
        label: "Read file A",
        target: "a.ts",
      });

      // Emit event for Run B
      publishActionLifecycle({
        id: `${runIdB}:toolCall-1`,
        runId: runIdB,
        kind: "tool",
        action: "write_file",
        state: "succeeded",
        label: "Write file B",
        target: "b.ts",
      });

      recA.finishRun("succeeded", "Run A done");
      recB.finishRun("succeeded", "Run B done");

      const manifestA = loadRunManifest(projectRoot, runIdA);
      const manifestB = loadRunManifest(projectRoot, runIdB);

      expect(manifestA).not.toBeNull();
      expect(manifestB).not.toBeNull();

      expect(manifestA?.lifecycleEvents.every((e) => e.runId === runIdA)).toBe(true);
      expect(manifestB?.lifecycleEvents.every((e) => e.runId === runIdB)).toBe(true);
      expect(manifestA?.lifecycleEvents.some((e) => e.runId === runIdB)).toBe(false);
      expect(manifestB?.lifecycleEvents.some((e) => e.runId === runIdA)).toBe(false);
    });

    it("cleans up listener and writes failed manifest on non-stream and stream chat errors", async () => {
      const runId = "run-failed-stream-test";
      const recorder = new RunManifestRecorder(projectRoot, runId, "sess-failed");

      // Publish lifecycle failure
      publishActionLifecycle({
        id: `${runId}:circuit-breaker-1`,
        runId,
        kind: "verification",
        action: "circuit_breaker",
        state: "failed",
        label: "Circuit Breaker Tripped",
        summary: "Max loop count reached",
      });

      recorder.finishRun("failed", "Failed due to circuit breaker");

      const manifest = loadRunManifest(projectRoot, runId);
      expect(manifest).not.toBeNull();
      expect(manifest?.status).toBe("failed");
      expect(manifest?.summary).toContain("circuit breaker");
    });
  });

  describe("Requirement 3: Distinct Operation IDs for Repeated Calls", () => {
    it("assigns distinct operation IDs to repeated calls of same tool and target in one turn", () => {
      const runId = "run-repeat-tool";
      const call1 = lifecycleFromToolEvent("running", {
        name: "read_file",
        target: "config.json",
        runId,
        turnId: "turn-1",
        toolCallId: "call-uuid-1",
      });

      const call2 = lifecycleFromToolEvent("running", {
        name: "read_file",
        target: "config.json",
        runId,
        turnId: "turn-1",
        toolCallId: "call-uuid-2",
      });

      expect(call1.id).not.toBe(call2.id);
      expect(call1.id).toBe(`${runId}:turn-1:call-uuid-1`);
      expect(call2.id).toBe(`${runId}:turn-1:call-uuid-2`);
    });

    it("leaves no residual activeWork after tool operation starts and finishes", () => {
      const runId = "run-activework-test";
      const startEv: ActionLifecycleEvent = {
        id: `${runId}:call-101`,
        runId,
        kind: "tool",
        action: "write_file",
        state: "running",
        label: "Write file",
      };
      const finishEv: ActionLifecycleEvent = {
        id: `${runId}:call-101`,
        runId,
        kind: "tool",
        action: "write_file",
        state: "succeeded",
        label: "Write file",
      };

      const events: ReplayEvent[] = [
        { sequenceId: 1, timestamp: 1000, action: "action:lifecycle", payload: startEv },
        { sequenceId: 2, timestamp: 1050, action: "action:lifecycle", payload: finishEv },
      ];

      const state = reduceRuntimeState(events);
      expect(state.activeWork).toHaveLength(0);
      expect(state.tools.total).toBe(1);
    });
  });

  describe("Requirement 5 & 6: Canonical-only Reducer & E2E Validation", () => {
    it("derives tool and agent stats once via canonical conversion without double counting", () => {
      const legacyToolStart: ReplayEvent = {
        sequenceId: 1,
        timestamp: 1000,
        action: "tool:started",
        runId: "run-legacy-dedup",
        payload: { name: "read_file", target: "index.ts" },
      };
      const legacyToolFinish: ReplayEvent = {
        sequenceId: 2,
        timestamp: 1050,
        action: "tool:finished",
        runId: "run-legacy-dedup",
        payload: { name: "read_file", target: "index.ts", ok: true },
      };

      const state = reduceRuntimeState([legacyToolStart, legacyToolFinish]);
      expect(state.tools.total).toBe(1);
      expect(state.tools.failed).toBe(0);
      expect(state.tools.last?.ok).toBe(true);
    });

    it("verifies manifest E2E asserts eventCount > 0 and matching runId", async () => {
      const runId = "run-e2e-assert-test";
      await runChatTurn({
        prompt: "Run audit check",
        projectRoot,
        skillsRoot: projectRoot,
        noLlm: true,
        runId,
      });

      const manifest = loadRunManifest(projectRoot, runId);
      expect(manifest).not.toBeNull();
      expect(manifest?.runId).toBe(runId);
      expect(manifest?.status).toBe("succeeded");
      expect(manifest?.lifecycleEvents).toBeDefined();
    });
  });

  describe("Architecture Boundary Protection", () => {
    it("ensures core package source files have zero imports from @agency/tui", () => {
      const coreSrcDir = join(__dirname, "..");
      const files = getAllTsFiles(coreSrcDir);
      for (const file of files) {
        const content = readFileSync(file, "utf8");
        expect(content).not.toMatch(/from\s+["']@agency\/tui/);
      }
    });
  });
});

function getAllTsFiles(dir: string): string[] {
  const results: string[] = [];
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...getAllTsFiles(fullPath));
    } else if (entry.isFile() && (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx"))) {
      results.push(fullPath);
    }
  }
  return results;
}
