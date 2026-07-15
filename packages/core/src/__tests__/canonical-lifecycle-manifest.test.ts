import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
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
  resolveRunId,
  MAX_RUN_MANIFESTS,
  MAX_MANIFEST_AGE_MS,
  type ActionLifecycleEvent,
  type RunManifest,
} from "../index.js";
import { EventBus } from "../events/event-bus.js";

describe("Runtime Control Plane Task 1 Integration Audit & Manifest Persistence", () => {
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

  describe("Canonical ActionLifecycleEvent & Redaction Safety", () => {
    it("sanitizes API keys, secrets, bearer tokens, and opaque Windows targets", () => {
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

    it("sanitizes and bounds rawDetail and oversized evidence string values", () => {
      const longString = "A".repeat(2000);
      const event: ActionLifecycleEvent = {
        id: "run-rawdetail-test",
        runId: "run-detail",
        kind: "tool",
        action: "read_file",
        state: "succeeded",
        label: "Read File",
        rawDetail: `Long stdout with secret sk-proj-12345678901234567890 and ${longString}`,
        evidence: {
          oversizedOutput: longString,
          authorizationHeader: "Bearer secret-token-value-1234567890",
        },
      };

      const sanitized = sanitizeLifecycleEvent(event);
      expect(typeof sanitized.rawDetail).toBe("string");
      expect(sanitized.rawDetail as string).not.toContain("sk-proj-1234567890");
      expect((sanitized.rawDetail as string).length).toBeLessThan(700);
      expect((sanitized.evidence?.oversizedOutput as string).length).toBeLessThan(1200);
      expect(sanitized.evidence?.authorizationHeader).toBe("[REDACTED]");
    });
  });

  describe("Legacy Event Migration Adapter Identity & Outcomes", () => {
    it("maps subagent events for the same dispatch to a single stable lifecycle ID", () => {
      const startEv: ReplayEvent = {
        sequenceId: 10,
        timestamp: 1000,
        action: "subagent:started",
        runId: "run-subagent-audit",
        payload: { dispatchId: "disp-101", agentId: "researcher", task: "Audit dependencies" },
      };

      const progressEv: ReplayEvent = {
        sequenceId: 11,
        timestamp: 1050,
        action: "subagent:progress",
        runId: "run-subagent-audit",
        payload: { dispatchId: "disp-101", agentId: "researcher", phase: "Parsing AST" },
      };

      const errorEv: ReplayEvent = {
        sequenceId: 12,
        timestamp: 1100,
        action: "subagent:error",
        runId: "run-subagent-audit",
        payload: { dispatchId: "disp-101", agentId: "researcher", result: "Fatal syntax error in module", error: "CompileError" },
      };

      const canonStart = convertLegacyEventToCanonical(startEv);
      const canonProgress = convertLegacyEventToCanonical(progressEv);
      const canonError = convertLegacyEventToCanonical(errorEv);

      expect(canonStart?.id).toBe("run-subagent-audit:subagent:disp-101");
      expect(canonProgress?.id).toBe("run-subagent-audit:subagent:disp-101");
      expect(canonError?.id).toBe("run-subagent-audit:subagent:disp-101");
      expect(canonError?.state).toBe("failed");
      expect(canonError?.summary).toBe("CompileError");
      expect(canonError?.evidence?.result).toBe("Fatal syntax error in module");
    });

    it("does not convert unknown system:warning into verification failed", () => {
      const warningEv: ReplayEvent = {
        sequenceId: 99,
        timestamp: 2000,
        action: "system:warning",
        runId: "run-warning-test",
        payload: { message: "Low disk space notice" },
      };

      const canonical = convertLegacyEventToCanonical(warningEv);
      expect(canonical).toBeNull();

      const state = reduceRuntimeState([warningEv]);
      expect(state.warnings).toBe(1);
      expect(state.latestCanonicalEvents).toHaveLength(0);
    });
  });

  describe("Reducer Correctness & Regression Protection", () => {
    it("counts legacy tool started + finished exactly ONCE without duplicate counters or stale active work", () => {
      const events: ReplayEvent[] = [
        {
          sequenceId: 1,
          timestamp: 1000,
          action: "tool:started",
          runId: "run-reducer-test",
          payload: { name: "write_file", target: "src/main.ts", category: "fs" },
        },
        {
          sequenceId: 2,
          timestamp: 1050,
          action: "tool:finished",
          runId: "run-reducer-test",
          payload: { name: "write_file", target: "src/main.ts", action: "write", summary: "File written" },
        },
      ];

      const state = reduceRuntimeState(events);
      expect(state.tools.total).toBe(1);
      expect(state.tools.failed).toBe(0);
      expect(state.tools.last?.ok).toBe(true);
      expect(state.activeWork).toHaveLength(0);
    });

    it("clears active work when subagent errors and retains real error result", () => {
      const events: ReplayEvent[] = [
        {
          sequenceId: 1,
          timestamp: 1000,
          action: "subagent:started",
          runId: "run-agent-test",
          payload: { dispatchId: "d1", agentId: "coder", task: "Fix bug" },
        },
        {
          sequenceId: 2,
          timestamp: 1100,
          action: "subagent:error",
          runId: "run-agent-test",
          payload: { dispatchId: "d1", agentId: "coder", error: "TypeScript build failed" },
        },
      ];

      const state = reduceRuntimeState(events);
      expect(state.activeWork).toHaveLength(0);
      expect(state.agents).toHaveLength(1);
      expect(state.agents[0]?.status).toBe("error");
    });

    it("ensures circuit breaker and incomplete stop reasons never resolve to succeeded", () => {
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

  describe("Run Manifest Store & Atomic Write Integration", () => {
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

  describe("Real Execution Entrypoint Integration Tests", () => {
    it("persists .agency/runs/<runId>.json on real runChatTurn completion", async () => {
      const runId = "run-chat-e2e-audit";
      const result = await runChatTurn({
        prompt: "Check system health",
        projectRoot,
        skillsRoot: projectRoot,
        noLlm: true,
        runId,
      });

      expect(result).toBeDefined();
      const manifest = loadRunManifest(projectRoot, runId);
      expect(manifest).not.toBeNull();
      expect(manifest?.runId).toBe(runId);
      expect(manifest?.status).toBe("succeeded");
    });

    it("persists .agency/runs/<runId>.json on real runWorkflow completion", async () => {
      const runId = "run-workflow-e2e-audit";
      const skillsRoot = join(process.cwd(), "packages", "skills-bridge", "resources", "packaged_skills");
      
      const result = await runWorkflow(skillsRoot, projectRoot, "create", {
        runId,
        yes: true,
      });

      expect(result).toBeDefined();
      const manifest = loadRunManifest(projectRoot, runId);
      expect(manifest).not.toBeNull();
      expect(manifest?.runId).toBe(runId);
      expect(["succeeded", "failed"]).toContain(manifest?.status);
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
