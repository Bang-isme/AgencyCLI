import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const PKG_ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "../..");
const CLI_ENTRY = join(PKG_ROOT, "dist", "index.js");

const dirs: string[] = [];

afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs.length = 0;
});

// A minimal, well-formed DeterministicExecutionTrace (two turns, two tool calls).
function trace(sessionId: string, toolOutputs: unknown[], timings = [100, 200]) {
  return { sessionId, goal: `goal-${sessionId}`, timings, toolOutputs };
}
const VIEW = { toolName: "view_file", arguments: { path: "a.ts" }, output: "x", timestamp: 1 };
const WRITE = { toolName: "write_file", arguments: { path: "a.ts", content: "y" }, output: "ok", timestamp: 2 };
const DELETE = { toolName: "delete_file", arguments: { path: "b.ts" }, output: "gone", timestamp: 3 };

function newRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "agency-replay-reg-"));
  dirs.push(root);
  mkdirSync(join(root, ".agency", "traces"), { recursive: true });
  return root;
}

function seedTrace(root: string, id: string, body: unknown): void {
  writeFileSync(join(root, ".agency", "traces", `${id}.json`), JSON.stringify(body), "utf8");
}

function run(root: string, args: string[]) {
  return spawnSync(process.execPath, [CLI_ENTRY, "replay-regression", "--project-root", root, "--json", ...args], {
    encoding: "utf8",
  });
}

describe("agency replay-regression", () => {
  it("lists recorded traces (and exits 0)", () => {
    const root = newRoot();
    seedTrace(root, "s1", trace("s1", [VIEW, WRITE]));
    seedTrace(root, "s2", trace("s2", [VIEW]));
    const result = run(root, ["--list"]);
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout) as { traces: Array<{ sessionId: string; turns: number; toolCalls: number }> };
    expect(parsed.traces).toHaveLength(2);
    const s1 = parsed.traces.find((t) => t.sessionId === "s1");
    expect(s1).toMatchObject({ turns: 2, toolCalls: 2 });
  });

  it("validates a well-formed trace (exit 0)", () => {
    const root = newRoot();
    seedTrace(root, "s1", trace("s1", [VIEW, WRITE]));
    const result = run(root, ["s1"]);
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout) as { mode: string; success: boolean; turnsReplayed: number };
    expect(parsed.mode).toBe("validate");
    expect(parsed.success).toBe(true);
    expect(parsed.turnsReplayed).toBe(2);
  });

  it("fails validation on a parseable-but-not-a-trace file (exit 1)", () => {
    const root = newRoot();
    seedTrace(root, "bad", { not: "a trace" });
    const result = run(root, ["bad"]);
    expect(result.status).toBe(1);
    const parsed = JSON.parse(result.stdout) as { success: boolean; error?: string };
    expect(parsed.success).toBe(false);
    expect(parsed.error).toBeTruthy();
  });

  it("passes regression when the candidate matches the baseline (exit 0)", () => {
    const root = newRoot();
    seedTrace(root, "base", trace("base", [VIEW, WRITE]));
    seedTrace(root, "cand", trace("cand", [VIEW, WRITE]));
    const result = run(root, ["cand", "--baseline", "base"]);
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout) as { mode: string; success: boolean; unconsumedOutputs: number };
    expect(parsed.mode).toBe("regression");
    expect(parsed.success).toBe(true);
    expect(parsed.unconsumedOutputs).toBe(0);
  });

  it("flags drift when the candidate omits a baseline tool call (exit 1)", () => {
    const root = newRoot();
    seedTrace(root, "base", trace("base", [VIEW, WRITE]));
    seedTrace(root, "cand", trace("cand", [VIEW])); // missing WRITE
    const result = run(root, ["cand", "--baseline", "base"]);
    expect(result.status).toBe(1);
    const parsed = JSON.parse(result.stdout) as { success: boolean; unconsumedOutputs: number };
    expect(parsed.success).toBe(false);
    expect(parsed.unconsumedOutputs).toBeGreaterThanOrEqual(1);
  });

  it("flags a deviation when the candidate calls a tool absent from the baseline (exit 1)", () => {
    const root = newRoot();
    seedTrace(root, "base", trace("base", [VIEW, WRITE]));
    seedTrace(root, "cand", trace("cand", [VIEW, WRITE, DELETE])); // extra DELETE
    const result = run(root, ["cand", "--baseline", "base"]);
    expect(result.status).toBe(1);
    const parsed = JSON.parse(result.stdout) as { success: boolean; error?: string };
    expect(parsed.success).toBe(false);
    expect(parsed.error).toContain("[Replay Deviation]");
  });
});
