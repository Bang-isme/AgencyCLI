import { describe, expect, it, beforeEach, afterEach } from "vitest";
import {
  CapabilityRegistry,
  CapabilityDescriptor,
  publishActionLifecycle,
  lifecycleFromToolEvent,
  ACTION_LIFECYCLE_TOPIC,
  ACTION_SUCCEEDED_TOPIC,
  ACTION_FAILED_TOPIC,
  ActionLifecycleEvent,
} from "../index.js";
import { EventBus } from "../events/event-bus.js";
import * as fs from "node:fs";
import * as path from "node:path";

describe("Empirical Stress & Edge Case Harness for CapabilityRegistry and ActionLifecycleEvent", () => {
  let eventBus: EventBus;
  const rootRepoDir = path.resolve(process.cwd(), "../..");

  beforeEach(() => {
    eventBus = EventBus.getInstance();
    eventBus.clear();
  });

  afterEach(() => {
    eventBus.clear();
  });

  // =========================================================================
  // SECTION 1: CapabilityRegistry Dynamic Registration, Unregistration & Alias Handling
  // =========================================================================
  describe("CapabilityRegistry - Dynamic Registration & Alias Resolution", () => {
    it("handles case-insensitive alias resolution and lookup", () => {
      const registry = new CapabilityRegistry();
      registry.register({
        id: "git_status",
        tier: "core",
        surfaces: ["cli", "tui"],
        label: "Git Status",
        description: "Check status",
        category: "review",
        risk: "low",
        prerequisites: [],
        aliases: ["GST", "stat", "Status-Check"],
      });

      expect(registry.has("git_status")).toBe(true);
      expect(registry.has("gst")).toBe(true);
      expect(registry.has("GST")).toBe(true);
      expect(registry.has("STAT")).toBe(true);
      expect(registry.has("status-check")).toBe(true);

      expect(registry.resolveId("GST")).toBe("git_status");
      expect(registry.resolveId("stat")).toBe("git_status");
      expect(registry.get("STATUS-CHECK")?.id).toBe("git_status");
    });

    it("safely cleans up previous aliases when re-registering capability", () => {
      const registry = new CapabilityRegistry();
      registry.register({
        id: "cap1",
        tier: "core",
        surfaces: ["cli"],
        label: "Cap 1",
        description: "V1",
        category: "workspace",
        risk: "low",
        prerequisites: [],
        aliases: ["old_alias", "shared_alias"],
      });

      expect(registry.has("old_alias")).toBe(true);

      // Re-register cap1 with a new list of aliases (omitting old_alias)
      registry.register({
        id: "cap1",
        tier: "core",
        surfaces: ["cli"],
        label: "Cap 1 Updated",
        description: "V2",
        category: "workspace",
        risk: "low",
        prerequisites: [],
        aliases: ["new_alias", "shared_alias"],
      });

      // cap1's descriptor no longer contains 'old_alias'
      const capHasOldAlias = registry.get("cap1")?.aliases?.includes("old_alias");
      expect(capHasOldAlias).toBe(false);

      // Cleaned up: old_alias no longer resolves to cap1
      const resolvesOld = registry.resolveId("old_alias");
      expect(resolvesOld).toBeUndefined();
    });

    it("prevents alias deletion from affecting other registered capabilities upon unregistration", () => {
      const registry = new CapabilityRegistry();
      
      // Cap A registered with alias 'run'
      registry.register({
        id: "cap_a",
        tier: "core",
        surfaces: ["cli"],
        label: "Cap A",
        description: "First",
        category: "workspace",
        risk: "low",
        prerequisites: [],
        aliases: ["run", "a_alias"],
      });

      // Cap B registered with same alias 'run' (collision)
      registry.register({
        id: "cap_b",
        tier: "advanced",
        surfaces: ["cli"],
        label: "Cap B",
        description: "Second",
        category: "workspace",
        risk: "low",
        prerequisites: [],
        aliases: ["run", "b_alias"],
      });

      // Alias 'run' now points to cap_b (hijacked cap_a's alias)
      expect(registry.resolveId("run")).toBe("cap_b");

      // Now unregister Cap B
      const unregSuccess = registry.unregister("cap_b");
      expect(unregSuccess).toBe(true);
      expect(registry.has("cap_b")).toBe(false);

      // Cap A is still registered with its own alias 'a_alias'
      expect(registry.has("cap_a")).toBe(true);
      expect(registry.has("a_alias")).toBe(true);
    });

    it("handles unregistration by alias vs by ID", () => {
      const registry = new CapabilityRegistry();
      registry.register({
        id: "search_code",
        tier: "core",
        surfaces: ["cli", "tool"],
        label: "Search Code",
        description: "Grep codebase",
        category: "workspace",
        risk: "low",
        prerequisites: [],
        aliases: ["grep", "find"],
      });

      // Unregister using alias "grep"
      expect(registry.unregister("grep")).toBe(true);
      expect(registry.has("search_code")).toBe(false);
      expect(registry.has("grep")).toBe(false);
      expect(registry.has("find")).toBe(false);

      // Subsequent unregister returns false
      expect(registry.unregister("search_code")).toBe(false);
      expect(registry.unregister("grep")).toBe(false);
    });
  });

  // =========================================================================
  // SECTION 2: Prerequisite Evaluation Scenarios
  // =========================================================================
  describe("CapabilityRegistry - Prerequisite Evaluation", () => {
    it("evaluates built-in prerequisite 'git_repo'", async () => {
      const registry = new CapabilityRegistry();
      registry.register({
        id: "git_diff",
        tier: "core",
        surfaces: ["cli"],
        label: "Git Diff",
        description: "Diff files",
        category: "review",
        risk: "low",
        prerequisites: ["git_repo"],
      });

      // AgencyCLI root directory should have .git
      const resProject = await registry.checkPrerequisites("git_diff", rootRepoDir);
      expect(resProject.satisfied).toBe(true);
      expect(resProject.missing).toHaveLength(0);

      // Subpackage directory (d:/AgencyCLI/packages/core) returns false because evaluateBuiltinPrereq only checks exact path/.git
      const resSubpackage = await registry.checkPrerequisites("git_diff", process.cwd());
      expect(resSubpackage.satisfied).toBe(false);

      // Temp directory without .git
      const emptyDir = path.join(process.cwd(), "node_modules", ".tmp_no_git_test");
      if (!fs.existsSync(emptyDir)) fs.mkdirSync(emptyDir, { recursive: true });

      try {
        const resEmpty = await registry.checkPrerequisites("git_diff", emptyDir);
        expect(resEmpty.satisfied).toBe(false);
        expect(resEmpty.missing).toContain("git_repo");
      } finally {
        if (fs.existsSync(emptyDir)) fs.rmdirSync(emptyDir);
      }
    });

    it("evaluates custom prerequisite check functions (sync, async, failing, throwing)", async () => {
      const registry = new CapabilityRegistry();
      let customChecked = false;

      registry.register({
        id: "custom_cap",
        tier: "advanced",
        surfaces: ["tool"],
        label: "Custom Cap",
        description: "Desc",
        category: "tool",
        risk: "high",
        prerequisites: [
          {
            id: "custom_prereq_ok",
            description: "Custom check passing",
            check: async (_root) => {
              customChecked = true;
              return true;
            },
          },
          {
            id: "custom_prereq_fail",
            description: "Custom check failing",
            check: (_root) => false,
          },
        ],
      });

      const res = await registry.checkPrerequisites("custom_cap", rootRepoDir);
      expect(customChecked).toBe(true);
      expect(res.satisfied).toBe(false);
      expect(res.missing).toEqual(["custom_prereq_fail"]);
    });

    it("catches exceptions in custom prerequisite check functions", async () => {
      const registry = new CapabilityRegistry();
      registry.register({
        id: "throwing_cap",
        tier: "advanced",
        surfaces: ["tool"],
        label: "Throwing Cap",
        description: "Desc",
        category: "tool",
        risk: "high",
        prerequisites: [
          {
            id: "buggy_prereq",
            description: "Prereq that throws an error",
            check: () => {
              throw new Error("Disk read error during prereq check");
            },
          },
        ],
      });

      // Exception in check() is caught safely and records missing prerequisite
      const res = await registry.checkPrerequisites("throwing_cap", rootRepoDir);
      expect(res.satisfied).toBe(false);
      expect(res.missing).toEqual(["buggy_prereq"]);
    });

    it("handles non-existent capability in checkPrerequisites", async () => {
      const registry = new CapabilityRegistry();
      const res = await registry.checkPrerequisites("non_existent_cap", rootRepoDir);
      expect(res.satisfied).toBe(false);
      expect(res.missing[0]).toContain('Capability "non_existent_cap" not found');
    });
  });

  // =========================================================================
  // SECTION 3: Edge Cases (Missing Fields, Invalid Types, Duplicate Aliases)
  // =========================================================================
  describe("Edge Cases - Missing Fields & Malformed Inputs", () => {
    it("handles missing surfaces array without throwing TypeError in list()", () => {
      const registry = new CapabilityRegistry();
      
      const malformedDescriptor = {
        id: "malformed_cap",
        tier: "core",
        label: "Malformed",
        description: "No surfaces defined",
        category: "workspace",
        risk: "low",
      } as unknown as CapabilityDescriptor;

      registry.register(malformedDescriptor);

      expect(registry.has("malformed_cap")).toBe(true);

      // Does not throw TypeError when surface filter is supplied
      const result = registry.list({ surface: "tui" });
      expect(Array.isArray(result)).toBe(true);
      expect(result.some((c) => c.id === "malformed_cap")).toBe(false);
    });

    it("handles registerToolDefinition defaults and edge cases", () => {
      const registry = new CapabilityRegistry();
      
      const coreTool = registry.registerToolDefinition("read_file_content", "Reads content");
      expect(coreTool.tier).toBe("core");
      expect(coreTool.surfaces).toEqual(["tool"]);
      expect(coreTool.icon).toBe("⚙");

      const advTool = registry.registerToolDefinition("execute_custom_script", "Executes script", "automation", "critical", "Check script");
      expect(advTool.tier).toBe("advanced");
      expect(advTool.risk).toBe("critical");
      expect(advTool.recoveryAction).toBe("Check script");
    });

    it("calculates durationMs using updatedAt - startedAt in lifecycleFromToolEvent when durationMs is omitted", () => {
      const event1 = lifecycleFromToolEvent("queued", {});
      expect(event1.action).toBe("tool");
      expect(event1.state).toBe("queued");
      expect(event1.label).toBe("tool");

      // Test event where startedAt = 1000 and updatedAt = 2000, but durationMs omitted
      const event2 = lifecycleFromToolEvent("failed", {
        action: "read_file",
        target: "C:\\Windows\\System32\\cmd.exe",
        startedAt: 1000,
        updatedAt: 2000,
        seq: 5,
        summary: "Read failed due to permissions",
      });

      expect(event2.action).toBe("read_file");
      expect(event2.target).toBe("C:\\Windows\\System32\\cmd.exe");
      expect(event2.label).toBe("Read file cmd.exe");

      // Correctly computes durationMs as updatedAt - startedAt = 1000
      expect(event2.durationMs).toBe(1000);
    });

    it("filters out opaque runtime targets (Windows winget / node executables)", () => {
      const eventWinget = lifecycleFromToolEvent("running", {
        name: "execute_command",
        target: "OpenJS.NodeJS.22_Microsoft.Winget.Source_8we",
      });
      expect(eventWinget.target).toBeUndefined();
      expect(eventWinget.label).toBe("Run command");

      const eventNormal = lifecycleFromToolEvent("running", {
        name: "execute_command",
        target: "pnpm test",
      });
      expect(eventNormal.target).toBe("pnpm test");
    });
  });

  // =========================================================================
  // SECTION 4: Stress Testing High-Volume ActionLifecycleEvent Emissions
  // =========================================================================
  describe("Stress Testing - High Volume ActionLifecycleEvents on EventBus", () => {
    it("processes high-volume event emissions (2,000 events) without memory leak or dropped order", async () => {
      const lifecycleEvents: ActionLifecycleEvent[] = [];
      const succeededEvents: ActionLifecycleEvent[] = [];

      eventBus.subscribe(ACTION_LIFECYCLE_TOPIC, (e) => {
        lifecycleEvents.push(JSON.parse(e.payload));
      });

      eventBus.subscribe(ACTION_SUCCEEDED_TOPIC, (e) => {
        succeededEvents.push(JSON.parse(e.payload));
      });

      const NUM_EVENTS = 2000;
      const startTime = Date.now();

      for (let i = 0; i < NUM_EVENTS; i++) {
        const evt: ActionLifecycleEvent = {
          id: `stress-evt-${i}`,
          turnId: `turn-${Math.floor(i / 100)}`,
          seq: i,
          action: `tool_action_${i % 10}`,
          state: "succeeded",
          label: `Tool Action ${i}`,
          target: `file_${i}.ts`,
          startedAt: startTime + i,
          updatedAt: startTime + i + 5,
        };

        publishActionLifecycle(evt);
      }

      // Wait for EventBus async drain queue passes to complete
      await new Promise((resolve) => setTimeout(resolve, 500));

      expect(lifecycleEvents.length).toBe(NUM_EVENTS);
      expect(succeededEvents.length).toBe(NUM_EVENTS);

      // Verify sequence ordering preservation
      for (let i = 0; i < NUM_EVENTS; i++) {
        expect(lifecycleEvents[i].seq).toBe(i);
        expect(succeededEvents[i].seq).toBe(i);
      }
    });

    it("handles deduplication window correctly under rapid duplicate publishing", async () => {
      let receiveCount = 0;
      eventBus.subscribe(ACTION_LIFECYCLE_TOPIC, () => {
        receiveCount++;
      });

      const duplicateEvent: ActionLifecycleEvent = {
        id: "static-dedup-id",
        action: "write_file",
        state: "running",
        label: "Write file",
        target: "config.json",
      };

      // Publish exact same event 10 times rapidly
      for (let i = 0; i < 10; i++) {
        publishActionLifecycle(duplicateEvent);
      }

      await new Promise((resolve) => setTimeout(resolve, 100));

      // Because EventBus deduplicates based on sha256(action + ":" + payloadStr),
      // only the 1st publication is accepted within the 5s window.
      expect(receiveCount).toBe(1);
    });

    it("handles large oversized payloads (> 8KB) via disk spill without blocking event delivery", async () => {
      const receivedEvents: any[] = [];
      eventBus.subscribe("large_action_topic", (e) => {
        receivedEvents.push(e);
      });

      // Generate > 8KB string payload
      const largePayload = "X".repeat(12000);
      const largeEvent = {
        id: "large-evt-1",
        action: "large_action_topic",
        data: largePayload,
      };

      const published = await eventBus.publish("large_action_topic", largeEvent);
      expect(published).toBe(true);

      await new Promise((resolve) => setTimeout(resolve, 150));

      expect(receivedEvents.length).toBe(1);
      const deliveredPayload = JSON.parse(receivedEvents[0].payload);

      // EventBus replaces >8KB payload with refId summary
      expect(deliveredPayload.refId).toBeDefined();
      expect(deliveredPayload.summary).toContain("Truncated large payload");

      // Clean up spilled payload file if created
      const spillRefId = deliveredPayload.refId;
      await eventBus.awaitSpill(spillRefId);

      const spillPath = path.join(".agency", "large-payloads", `${spillRefId}.json`);
      if (fs.existsSync(spillPath)) {
        fs.unlinkSync(spillPath);
      }
    });

    it("resists subscriber exceptions during high-volume burst", async () => {
      let goodReceived = 0;

      // Bad subscriber that throws
      eventBus.subscribe(ACTION_LIFECYCLE_TOPIC, () => {
        throw new Error("Flaky subscriber crashed!");
      });

      // Good subscriber
      eventBus.subscribe(ACTION_LIFECYCLE_TOPIC, () => {
        goodReceived++;
      });

      for (let i = 0; i < 100; i++) {
        publishActionLifecycle({
          id: `burst-${i}`,
          action: "read_file",
          state: "running",
          label: "Read file",
        });
      }

      await new Promise((resolve) => setTimeout(resolve, 150));

      // Good subscriber should receive all 100 events despite bad subscriber throwing
      expect(goodReceived).toBe(100);
    });
  });
});
