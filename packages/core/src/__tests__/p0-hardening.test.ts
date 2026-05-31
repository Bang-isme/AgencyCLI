import { describe, expect, it, afterEach, beforeEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getRuntimeFlags } from "../runtime/flags.js";
import { EventBus, type DurableEventSink } from "../events/event-bus.js";
import { enforceDelegationLimits, DelegationLimitError } from "../agents/orchestrator.js";
import { discoverRecoverableTasks } from "../runtime/bootstrap.js";
import { saveCheckpoint } from "../task/checkpoint.js";
import type { ReplayEvent } from "@agency/contracts";

// ---- helpers ----------------------------------------------------------------

const FLAG_KEYS = [
  "AGENCY_PROFILE",
  "AGENCY_PERSIST_EVENTS",
  "AGENCY_AUTO_RECOVER",
  "AGENCY_APPROVAL_IN_TOOLPATH",
  "AGENCY_DELEGATION_GUARDS",
  "AGENCY_MAX_DEPTH",
  "AGENCY_MAX_HOPS",
  "AGENCY_NESTING_DEPTH",
  "AGENCY_DELEGATION_CHAIN",
  "AGENCY_EXECUTION_BUDGET_MS",
  "AGENCY_MAX_PARALLEL_AGENTS",
  "AGENCY_MEMORY_GC",
];

function clearFlagEnv() {
  for (const k of FLAG_KEYS) delete process.env[k];
}

// ---- flags ------------------------------------------------------------------

describe("runtime flags", () => {
  afterEach(clearFlagEnv);

  it("defaults to the legacy profile with safe-but-observable settings", () => {
    clearFlagEnv();
    const f = getRuntimeFlags();
    expect(f.profile).toBe("legacy");
    expect(f.persistEvents).toBe(true); // additive + crash-safe → on
    expect(f.autoRecover).toBe(false); // behaviour-changing → off in legacy
    expect(f.approvalInToolPath).toBe("warn"); // non-blocking by default
    expect(f.delegationGuards).toBe(true);
    expect(f.maxDepth).toBe(8);
    expect(f.executionBudgetMs).toBe(0); // wall-clock deadline off in legacy
    expect(f.maxParallelAgents).toBe(3);
    expect(f.memoryGc).toBe(false);
  });

  it("hardened profile flips behaviour-changing defaults on", () => {
    clearFlagEnv();
    process.env.AGENCY_PROFILE = "hardened";
    const f = getRuntimeFlags();
    expect(f.autoRecover).toBe(true);
    expect(f.approvalInToolPath).toBe("enforce");
    expect(f.executionBudgetMs).toBe(300_000);
    expect(f.memoryGc).toBe(true);
  });

  it("AGENCY_EXECUTION_BUDGET_MS=0 explicitly disables the deadline even when hardened", () => {
    clearFlagEnv();
    process.env.AGENCY_PROFILE = "hardened";
    process.env.AGENCY_EXECUTION_BUDGET_MS = "0";
    expect(getRuntimeFlags().executionBudgetMs).toBe(0);
  });

  it("explicit env overrides win over profile defaults", () => {
    clearFlagEnv();
    process.env.AGENCY_PROFILE = "hardened";
    process.env.AGENCY_APPROVAL_IN_TOOLPATH = "off";
    process.env.AGENCY_MAX_DEPTH = "3";
    const f = getRuntimeFlags();
    expect(f.approvalInToolPath).toBe("off");
    expect(f.maxDepth).toBe(3);
  });
});

// ---- delegation guards ------------------------------------------------------

describe("delegation guards", () => {
  afterEach(clearFlagEnv);

  const req = (agentId: string) => ({ agentId: agentId as any, task: "t", projectRoot: "/tmp" });

  it("allows dispatch within depth and hop ceilings", () => {
    const env = { AGENCY_NESTING_DEPTH: "2", AGENCY_DELEGATION_CHAIN: "planner,coder" } as NodeJS.ProcessEnv;
    const ctx = enforceDelegationLimits(req("reviewer"), env);
    expect(ctx.depth).toBe(3);
    expect(ctx.chain).toEqual(["planner", "coder", "reviewer"]);
  });

  it("rejects when depth exceeds max_depth", () => {
    const env = { AGENCY_NESTING_DEPTH: "8", AGENCY_MAX_DEPTH: "8" } as NodeJS.ProcessEnv;
    expect(() => enforceDelegationLimits(req("x"), env)).toThrow(DelegationLimitError);
  });

  it("rejects circular delegation (A in its own chain)", () => {
    const env = { AGENCY_DELEGATION_CHAIN: "planner,coder" } as NodeJS.ProcessEnv;
    expect(() => enforceDelegationLimits(req("planner"), env)).toThrow(/[Cc]ircular/);
  });

  it("is a no-op when guards are disabled", () => {
    const env = { AGENCY_DELEGATION_GUARDS: "false", AGENCY_NESTING_DEPTH: "99" } as NodeJS.ProcessEnv;
    expect(() => enforceDelegationLimits(req("x"), env)).not.toThrow();
  });
});

// ---- durable event journal --------------------------------------------------

describe("EventBus durable journal", () => {
  const bus = EventBus.getInstance();
  afterEach(() => bus.clear());

  it("warm-loads sequence counter + tail from the sink", async () => {
    const prior: ReplayEvent[] = [
      { sequenceId: 41, timestamp: 1, action: "old:a", payloadHash: "h1", payload: "{}" },
      { sequenceId: 42, timestamp: 2, action: "old:b", payloadHash: "h2", payload: "{}" },
    ];
    const appended: ReplayEvent[] = [];
    const sink: DurableEventSink = {
      appendEvent: (e) => appended.push(e),
      readEvents: () => prior,
    };
    bus.attachDurableJournal(sink);

    // Tail restored
    expect(bus.getJournal().map((e) => e.sequenceId)).toEqual([41, 42]);

    // New events continue numbering past the restored max and mirror to the sink
    await bus.publish("new:event", { x: 1 });
    expect(appended).toHaveLength(1);
    expect(appended[0]!.sequenceId).toBe(43);
    bus.detachDurableJournal();
  });

  it("never throws when the sink append fails", async () => {
    const sink: DurableEventSink = {
      appendEvent: () => { throw new Error("disk full"); },
    };
    bus.attachDurableJournal(sink);
    await expect(bus.publish("any:event", { ok: true })).resolves.toBe(true);
    bus.detachDurableJournal();
  });
});

// ---- recovery discovery -----------------------------------------------------

describe("recovery discovery", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "agency-recover-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("finds running/paused checkpoints and ignores terminal ones", () => {
    saveCheckpoint(root, { id: "a", planPath: "p.md", currentTask: 2, completed: [1], status: "running", updatedAt: "" });
    saveCheckpoint(root, { id: "b", planPath: "p.md", currentTask: 0, completed: [], status: "paused", updatedAt: "" });
    saveCheckpoint(root, { id: "c", planPath: "p.md", currentTask: 9, completed: [1, 2], status: "done", updatedAt: "" });
    saveCheckpoint(root, { id: "d", planPath: "p.md", currentTask: 1, completed: [], status: "aborted", updatedAt: "" });

    const recoverable = discoverRecoverableTasks(root);
    const ids = recoverable.map((t) => t.id).sort();
    expect(ids).toEqual(["a", "b"]);
  });

  it("returns empty for a project with no tasks dir", () => {
    expect(discoverRecoverableTasks(join(root, "nonexistent"))).toEqual([]);
  });
});
