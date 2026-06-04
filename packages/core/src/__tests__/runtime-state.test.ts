import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ReplayEvent } from "@agency/contracts";
import { reduceRuntimeState, loadRuntimeState } from "../runtime/runtime-state.js";
import { EventJournal } from "../events/event-journal.js";

let seq = 0;
function ev(action: string, payload: unknown, extra: Partial<ReplayEvent> = {}): ReplayEvent {
  return {
    sequenceId: ++seq,
    timestamp: 1_000 + seq,
    action,
    payloadHash: "h",
    payload: typeof payload === "string" ? payload : JSON.stringify(payload),
    ...extra,
  };
}

describe("reduceRuntimeState", () => {
  it("folds an empty journal into a well-formed empty state", () => {
    const s = reduceRuntimeState([]);
    expect(s.eventCount).toBe(0);
    expect(s.plan).toEqual([]);
    expect(s.modifiedFiles).toEqual([]);
    expect(s.tools).toEqual({ total: 0, failed: 0, byCategory: {} });
    expect(s.agents).toEqual([]);
    expect(s.continuations).toBe(0);
    expect(s.warnings).toBe(0);
  });

  it("folds tool lifecycle into counts, categories, last, and modified files", () => {
    seq = 0;
    const s = reduceRuntimeState([
      ev("tool:started", { name: "read_file", category: "fs", action: "read", target: "a.ts" }),
      ev("tool:finished", { name: "read_file", category: "fs", action: "read", target: "a.ts", ok: true, summary: "12 lines" }),
      ev("tool:started", { name: "write_file", category: "fs", action: "write", target: "b.ts" }),
      ev("tool:finished", { name: "write_file", category: "fs", action: "write", target: "b.ts", ok: true, summary: "1.2 KB" }),
      ev("tool:started", { name: "execute_command", category: "exec", action: "exec", target: "npm run build" }),
      ev("tool:failed", { name: "execute_command", category: "exec", action: "exec", target: "npm run build", ok: false, summary: "exit 1" }),
      ev("tool:started", { name: "edit_file", category: "fs", action: "edit", target: "b.ts" }),
      ev("tool:finished", { name: "edit_file", category: "fs", action: "edit", target: "b.ts", ok: true, summary: "edited" }),
    ]);
    expect(s.tools.total).toBe(4);
    expect(s.tools.failed).toBe(1);
    expect(s.tools.byCategory).toEqual({ fs: 3, exec: 1 });
    expect(s.tools.last).toEqual({ name: "edit_file", ok: true, target: "b.ts", summary: "edited" });
    // b.ts written + edited but de-duped; a.ts was a read (not mutating); build failed (not counted).
    expect(s.modifiedFiles).toEqual(["b.ts"]);
  });

  it("takes the latest plan:updated and derives progress", () => {
    seq = 0;
    const s = reduceRuntimeState([
      ev("plan:updated", { todos: [{ step: "one", status: "pending" }] }),
      ev("plan:updated", {
        todos: [
          { step: "one", status: "completed" },
          { step: "two", status: "in_progress" },
          { step: "three", status: "pending" },
          { step: "", status: "pending" }, // empty step dropped
        ],
      }),
    ]);
    expect(s.plan).toEqual([
      { step: "one", status: "completed" },
      { step: "two", status: "in_progress" },
      { step: "three", status: "pending" },
    ]);
    expect(s.planProgress).toEqual({ completed: 1, inProgress: 1, pending: 1 });
  });

  it("tracks the latest state per subagent", () => {
    seq = 0;
    const s = reduceRuntimeState([
      ev("subagent:started", { agentId: "frontend-specialist", task: "build hero" }),
      ev("subagent:progress", { agentId: "frontend-specialist", phase: "Executing LLM Turn", elapsedMs: 1200 }),
      ev("subagent:started", { agentId: "test-engineer", task: "write tests" }),
      ev("subagent:finished", { agentId: "frontend-specialist", exitCode: 0, elapsedMs: 3400 }),
      ev("subagent:error", { agentId: "test-engineer", exitCode: 1 }),
    ]);
    const fe = s.agents.find((a) => a.agentId === "frontend-specialist")!;
    const te = s.agents.find((a) => a.agentId === "test-engineer")!;
    expect(fe).toMatchObject({ status: "done", phase: "Executing LLM Turn", elapsedMs: 3400, exitCode: 0, task: "build hero" });
    expect(te).toMatchObject({ status: "error", exitCode: 1 });
  });

  it("counts continuations, warnings, and attributed cost/duration", () => {
    seq = 0;
    const s = reduceRuntimeState([
      ev("continuation:started", { turnId: "t", loopCount: 15, maxLoops: 30, filesModified: 2 }),
      ev("system:warning", { message: "Context limit exceeded; retrying" }),
      ev("system:warning", { message: "Knowledge graph update failed" }),
      ev("subagent:finished", { agentId: "x", exitCode: 0 }, { durationMs: 500, costUsd: 0.01 }),
      ev("subagent:finished", { agentId: "y", exitCode: 0 }, { durationMs: 250, costUsd: 0.02 }),
    ]);
    expect(s.continuations).toBe(1);
    expect(s.warnings).toBe(2);
    expect(s.lastWarning).toBe("Knowledge graph update failed");
    expect(s.totalDurationMs).toBe(750);
    expect(s.totalCostUsd).toBeCloseTo(0.03, 5);
  });

  it("is total — a malformed payload is skipped, not thrown", () => {
    seq = 0;
    expect(() =>
      reduceRuntimeState([
        ev("plan:updated", "{ not valid json"),
        ev("tool:started", { name: "read_file", category: "fs", action: "read" }),
      ])
    ).not.toThrow();
    const s = reduceRuntimeState([
      ev("plan:updated", "{ not valid json"),
      ev("tool:started", { name: "read_file", category: "fs", action: "read" }),
    ]);
    expect(s.plan).toEqual([]);
    expect(s.tools.total).toBe(1);
  });
});

describe("loadRuntimeState", () => {
  it("returns empty state when no journal exists (no side effect)", () => {
    const root = mkdtempSync(join(tmpdir(), "agency-rs-empty-"));
    try {
      const s = loadRuntimeState(root);
      expect(s.eventCount).toBe(0);
    } finally {
      try {
        rmSync(root, { recursive: true, force: true });
      } catch {
        // Windows may hold a transient lock; best-effort cleanup.
      }
    }
  });

  it("folds a persisted journal round-trip", () => {
    const root = mkdtempSync(join(tmpdir(), "agency-rs-"));
    const journal = new EventJournal(root);
    try {
      seq = 0;
      journal.appendEvent(ev("tool:started", { name: "write_file", category: "fs", action: "write", target: "x.ts" }));
      journal.appendEvent(ev("tool:finished", { name: "write_file", category: "fs", action: "write", target: "x.ts", ok: true, summary: "1 KB" }));
      journal.appendEvent(ev("plan:updated", { todos: [{ step: "ship", status: "completed" }] }));
      journal.close();

      const s = loadRuntimeState(root);
      expect(s.eventCount).toBe(3);
      expect(s.modifiedFiles).toEqual(["x.ts"]);
      expect(s.plan).toEqual([{ step: "ship", status: "completed" }]);
      expect(s.planProgress.completed).toBe(1);
    } finally {
      try {
        journal.close();
      } catch {
        // already closed
      }
      try {
        rmSync(root, { recursive: true, force: true });
      } catch {
        // best-effort
      }
    }
  });
});
