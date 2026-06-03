import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import type { DagTaskNode } from "@agency/contracts";
import { detectDagCycle } from "../task/runner.js";
import { saveCheckpoint, loadCheckpoint, tasksDir, type TaskCheckpoint } from "../task/checkpoint.js";
import { EventBus } from "../events/event-bus.js";

function node(id: string, deps: string[]): DagTaskNode {
  return { id, dependencies: deps, action: id, params: {}, state: "PENDING", timeoutMs: 1000, attempts: 0 };
}

describe("detectDagCycle (static DAG cycle detection)", () => {
  it("returns null for an acyclic chain", () => {
    const nodes = {
      "task-1": node("task-1", []),
      "task-2": node("task-2", ["task-1"]),
      "task-3": node("task-3", ["task-2"]),
    };
    expect(detectDagCycle(nodes)).toBeNull();
  });

  it("returns null for a diamond (acyclic) DAG", () => {
    const nodes = {
      a: node("a", []),
      b: node("b", ["a"]),
      c: node("c", ["a"]),
      d: node("d", ["b", "c"]),
    };
    expect(detectDagCycle(nodes)).toBeNull();
  });

  it("detects a 2-node cycle and returns a closed path", () => {
    const nodes = {
      "task-1": node("task-1", ["task-2"]),
      "task-2": node("task-2", ["task-1"]),
    };
    const cycle = detectDagCycle(nodes);
    expect(cycle).not.toBeNull();
    expect(cycle![0]).toBe(cycle![cycle!.length - 1]); // closed loop
    expect(new Set(cycle)).toEqual(new Set(["task-1", "task-2"]));
  });

  it("detects a self-loop", () => {
    expect(detectDagCycle({ x: node("x", ["x"]) })).toEqual(["x", "x"]);
  });

  it("ignores dangling dependencies (not a cycle)", () => {
    expect(detectDagCycle({ a: node("a", ["ghost"]) })).toBeNull();
  });
});

describe("checkpoint integrity (checksum)", () => {
  let projectRoot = "";

  afterEach(() => {
    delete process.env.AGENCY_CHECKPOINT_STRICT;
    if (projectRoot) {
      rmSync(projectRoot, { recursive: true, force: true });
      projectRoot = "";
    }
  });

  const base = (): TaskCheckpoint => ({
    id: "cp1",
    planPath: "plan.md",
    currentTask: 1,
    completed: [0],
    status: "running",
    updatedAt: "",
  });

  it("seals a saved checkpoint and loads it back even under strict mode", () => {
    projectRoot = mkdtempSync(join(tmpdir(), "agency-cp-"));
    process.env.AGENCY_CHECKPOINT_STRICT = "true";

    saveCheckpoint(projectRoot, base());
    const loaded = loadCheckpoint(projectRoot, "cp1");

    expect(loaded).not.toBeNull();
    expect(loaded!.currentTask).toBe(1);
    expect(typeof loaded!.checksum).toBe("string");
  });

  it("rejects a tampered checkpoint in strict mode, loads it (warn) in legacy", () => {
    projectRoot = mkdtempSync(join(tmpdir(), "agency-cp-"));
    saveCheckpoint(projectRoot, base());

    // Tamper with the persisted content WITHOUT recomputing the checksum.
    const file = join(tasksDir(projectRoot), "cp1.json");
    const obj = JSON.parse(readFileSync(file, "utf8"));
    obj.currentTask = 99;
    writeFileSync(file, JSON.stringify(obj, null, 2), "utf8");

    process.env.AGENCY_CHECKPOINT_STRICT = "true";
    expect(loadCheckpoint(projectRoot, "cp1")).toBeNull();

    process.env.AGENCY_CHECKPOINT_STRICT = "false";
    const lenient = loadCheckpoint(projectRoot, "cp1");
    expect(lenient).not.toBeNull();
    expect(lenient!.currentTask).toBe(99);
  });

  // EventBus delivers to subscribers asynchronously (scheduleDrain → setImmediate),
  // so assertions await a tick. Warnings are filtered by the task id in the payload
  // because the bus is a singleton shared across tests (avoids cross-test bleed).
  const tick = () => new Promise((resolve) => setImmediate(resolve));
  const warningsFor = (sink: any[], id: string) =>
    sink.filter((e) => String(e?.payload ?? "").includes(id));

  it("warns (not silent) when a present checkpoint is corrupt/unparseable", async () => {
    // A checkpoint file that exists but can't be parsed = lost recoverable state.
    // It must be surfaced, not silently treated as "no checkpoint".
    projectRoot = mkdtempSync(join(tmpdir(), "agency-cp-"));
    mkdirSync(tasksDir(projectRoot), { recursive: true });
    writeFileSync(join(tasksDir(projectRoot), "corrupt-cp.json"), "{ not valid json ", "utf8");

    const warnings: any[] = [];
    EventBus.getInstance().subscribe("system:warning", (e) => warnings.push(e));
    const loaded = loadCheckpoint(projectRoot, "corrupt-cp");
    expect(loaded).toBeNull();
    // `void publish` is multi-hop async; a single setImmediate races under
    // full-suite CPU load (passes in isolation). Poll until the warning lands.
    for (let i = 0; i < 50 && warningsFor(warnings, "corrupt-cp").length === 0; i++) {
      await tick();
    }
    expect(warningsFor(warnings, "corrupt-cp").length).toBeGreaterThan(0);
  });

  it("returns null WITHOUT warning when no checkpoint exists (absent ≠ corrupt)", async () => {
    projectRoot = mkdtempSync(join(tmpdir(), "agency-cp-"));
    const warnings: any[] = [];
    EventBus.getInstance().subscribe("system:warning", (e) => warnings.push(e));
    const loaded = loadCheckpoint(projectRoot, "absent-cp");
    expect(loaded).toBeNull();
    await tick();
    expect(warningsFor(warnings, "absent-cp").length).toBe(0);
  });
});
