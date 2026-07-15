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
  MAX_RUN_MANIFESTS,
  MAX_MANIFEST_AGE_MS,
  type ActionLifecycleEvent,
  type RunManifest,
} from "../index.js";
import { EventBus } from "../events/event-bus.js";

describe("Runtime Control Plane Task 1 - Canonical Lifecycle, Legacy Adapter & Run Manifest", () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), "agency-control-plane-test-"));
    EventBus.getInstance().clear();
  });

  afterEach(() => {
    try {
      rmSync(projectRoot, { recursive: true, force: true });
    } catch {}
    EventBus.getInstance().clear();
  });

  describe("Canonical ActionLifecycleEvent & Redaction", () => {
    it("sanitizes API keys, secrets, and opaque Windows targets from evidence and target", () => {
      const rawEvent: ActionLifecycleEvent = {
        id: "run-1:turn-1:exec:seq-1",
        runId: "run-1",
        turnId: "turn-1",
        kind: "tool",
        action: "execute_command",
        state: "failed",
        label: "Execute OpenJS.NodeJS process",
        target: "Microsoft.Winget.Source_8wekyb3d8bbwe",
        summary: "Execution failed with api_key=\"sk-1234567890abcdef1234567890\"",
        evidence: {
          secretToken: "sk-proj-abcdef12345678901234567890",
          nested: {
            auth_token: "Bearer AIzaSyABC1234567890abcdef1234567890123",
          },
        },
      };

      const sanitized = sanitizeLifecycleEvent(rawEvent);
      expect(sanitized.target).toBeUndefined();
      expect(sanitized.summary).not.toContain("sk-1234567890abcdef1234567890");
      expect(sanitized.summary).toContain("[REDACTED]");
      expect(sanitized.evidence?.secretToken).toBe("[REDACTED]");
      expect((sanitized.evidence?.nested as any)?.auth_token).toBe("[REDACTED]");
    });
  });

  describe("Legacy Event Migration Adapter", () => {
    it("converts legacy tool:started, tool:finished, and tool:failed events into canonical lifecycle events", () => {
      const startEv: ReplayEvent = {
        sequenceId: 1,
        timestamp: 1000,
        action: "tool:started",
        runId: "run-legacy-1",
        payload: { name: "write_file", target: "src/app.ts", category: "fs" },
      };
      const finishEv: ReplayEvent = {
        sequenceId: 2,
        timestamp: 1050,
        durationMs: 50,
        action: "tool:finished",
        runId: "run-legacy-1",
        payload: { name: "write_file", target: "src/app.ts", action: "write", summary: "Wrote 120 bytes" },
      };

      const canonStart = convertLegacyEventToCanonical(startEv);
      expect(canonStart).not.toBeNull();
      expect(canonStart?.kind).toBe("tool");
      expect(canonStart?.state).toBe("running");
      expect(canonStart?.runId).toBe("run-legacy-1");

      const canonFinish = convertLegacyEventToCanonical(finishEv);
      expect(canonFinish).not.toBeNull();
      expect(canonFinish?.kind).toBe("tool");
      expect(canonFinish?.state).toBe("succeeded");
      expect(canonFinish?.summary).toContain("Wrote 120 bytes");
    });

    it("converts legacy subagent and system:warning events into canonical lifecycle events", () => {
      const subagentEv: ReplayEvent = {
        sequenceId: 3,
        timestamp: 1100,
        action: "subagent:error",
        runId: "run-legacy-2",
        payload: { agentId: "worker-1", error: "Subagent failed compilation" },
      };
      const warningEv: ReplayEvent = {
        sequenceId: 4,
        timestamp: 1150,
        action: "system:warning",
        runId: "run-legacy-2",
        payload: { message: "Tool loop halted by circuit breaker after repeated failed calls." },
      };

      const canonAgent = convertLegacyEventToCanonical(subagentEv);
      expect(canonAgent?.kind).toBe("agent");
      expect(canonAgent?.state).toBe("failed");
      expect(canonAgent?.recoveryHint?.suggestion).toContain("Inspect subagent logs");

      const canonWarning = convertLegacyEventToCanonical(warningEv);
      expect(canonWarning?.kind).toBe("loop");
      expect(canonWarning?.state).toBe("failed");
      expect(canonWarning?.label).toBe("Circuit Breaker Tripped");
    });
  });

  describe("RuntimeState Reducer", () => {
    it("folds canonical events and active work correctly", () => {
      const canonicalEvents: ActionLifecycleEvent[] = [
        {
          id: "run-1:turn-1:write:1",
          runId: "run-1",
          kind: "tool",
          action: "write_file",
          state: "running",
          label: "Write src/index.ts",
          target: "src/index.ts",
        },
        {
          id: "run-1:turn-1:write:1",
          runId: "run-1",
          kind: "tool",
          action: "write_file",
          state: "succeeded",
          label: "Write src/index.ts",
          target: "src/index.ts",
          semantic: { category: "fs", operation: "write", label: "Write" },
        },
        {
          id: "run-1:turn-1:exec:2",
          runId: "run-1",
          kind: "tool",
          action: "execute_command",
          state: "running",
          label: "Run tests",
          target: "pnpm test",
        },
      ];

      const replayEvents: ReplayEvent[] = canonicalEvents.map((ce, idx) => ({
        sequenceId: idx + 1,
        timestamp: 1000 + idx * 10,
        action: "action:lifecycle",
        payload: ce,
      }));

      const state = reduceRuntimeState(replayEvents);
      expect(state.eventCount).toBe(3);
      expect(state.tools.total).toBe(2);
      expect(state.tools.last?.ok).toBe(true);
      expect(state.modifiedFiles).toContain("src/index.ts");
      expect(state.activeWork).toHaveLength(1);
      expect(state.activeWork![0]?.id).toBe("run-1:turn-1:exec:2");
    });

    it("ensures failures, cancellations, and loop limits never reduce to succeeded/done", () => {
      const failedLifecycle: ActionLifecycleEvent = {
        id: "run-2:turn-1:exec:1",
        runId: "run-2",
        kind: "verification",
        action: "circuit_breaker",
        state: "failed",
        label: "Circuit Breaker Tripped",
        summary: "Repeated identical calls halted execution",
      };

      const events: ReplayEvent[] = [
        {
          sequenceId: 1,
          timestamp: 2000,
          action: "action:lifecycle",
          payload: failedLifecycle,
        },
      ];

      const state = reduceRuntimeState(events);
      expect(state.tools.last?.ok).toBeFalsy();
      expect(state.activeWork).toHaveLength(0);
      expect(state.latestCanonicalEvents![0]?.state).toBe("failed");
      expect(state.latestCanonicalEvents![0]?.state).not.toBe("succeeded");
    });
  });

  describe("Run Manifest Store & Retention Enforcement", () => {
    it("persists sanitized run manifest atomically to .agency/runs/<runId>.json", () => {
      const manifest: RunManifest = {
        runId: "run-test-atomic",
        startedAt: 1000,
        updatedAt: 2000,
        status: "succeeded",
        summary: "Completed feature implementation with secret sk-1234567890abcdef1234567890",
        eventCount: 5,
        modifiedFiles: ["src/a.ts", "src/b.ts"],
        lifecycleEvents: [
          {
            id: "run-test-atomic:turn-1:tool:1",
            runId: "run-test-atomic",
            kind: "tool",
            action: "write_file",
            state: "succeeded",
            label: "Write src/a.ts",
            evidence: { secretKey: "sk-proj-12345678901234567890" },
          },
        ],
      };

      saveRunManifest(projectRoot, manifest);

      const loaded = loadRunManifest(projectRoot, "run-test-atomic");
      expect(loaded).not.toBeNull();
      expect(loaded?.runId).toBe("run-test-atomic");
      expect(loaded?.summary).not.toContain("sk-1234567890");
      expect(loaded?.lifecycleEvents[0]?.evidence?.secretKey).toBe("[REDACTED]");

      const manifests = listRunManifests(projectRoot);
      expect(manifests).toHaveLength(1);
      expect(manifests[0]?.runId).toBe("run-test-atomic");
    });

    it("enforces retention policy: caps max manifests to 20 and purges entries older than 30 days", () => {
      const runsDir = join(projectRoot, ".agency", "runs");
      saveRunManifest(projectRoot, {
        runId: "run-old-expired",
        startedAt: 100,
        updatedAt: 200,
        status: "failed",
        summary: "Old run",
        eventCount: 1,
        modifiedFiles: [],
        lifecycleEvents: [],
      });

      // Backdate run-old-expired to 31 days ago
      const oldPath = join(runsDir, "run-old-expired.json");
      const thirtyOneDaysAgo = Date.now() - (MAX_MANIFEST_AGE_MS + 24 * 60 * 60 * 1000);
      utimesSync(oldPath, new Date(thirtyOneDaysAgo), new Date(thirtyOneDaysAgo));

      // Save 25 fresh manifests
      for (let i = 1; i <= 25; i++) {
        saveRunManifest(projectRoot, {
          runId: `run-fresh-${i}`,
          startedAt: Date.now() + i * 100,
          updatedAt: Date.now() + i * 100,
          status: "succeeded",
          summary: `Fresh run ${i}`,
          eventCount: 1,
          modifiedFiles: [],
          lifecycleEvents: [],
        });
      }

      const all = listRunManifests(projectRoot);
      expect(all.length).toBeLessThanOrEqual(MAX_RUN_MANIFESTS);
      expect(all.find((m) => m.runId === "run-old-expired")).toBeUndefined();
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
