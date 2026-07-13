import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("execa", () => ({
  execa: vi.fn(async () => ({
    exitCode: 1,
    stderr: "mock build failure",
    stdout: "",
  })),
}));
import { buildAcceptanceCommandsStrict } from "../utils/package-manager.js";
import { snapshotWorkspace, workspaceChangedSince } from "../utils/workspace-snapshot.js";
import { getRuntimeFlags } from "../runtime/flags.js";
import { verifyAndHeal } from "../chat/verify-turn.js";
import { EventBus } from "../events/event-bus.js";

describe("buildAcceptanceCommandsStrict", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "mtv-acc-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const writePkg = (scripts: Record<string, string>) =>
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "x", scripts }));

  it("returns [] when there is no package.json (don't fail a plain chat turn)", () => {
    expect(buildAcceptanceCommandsStrict(dir, { lint: true, test: true })).toEqual([]);
  });

  it("returns [] when package.json defines none of build/lint/test", () => {
    writePkg({ start: "node ." });
    expect(buildAcceptanceCommandsStrict(dir, { lint: true, test: true })).toEqual([]);
  });

  it("includes build only when a build script exists (never a guessed tsc)", () => {
    writePkg({ build: "tsc -p ." });
    expect(buildAcceptanceCommandsStrict(dir)).toEqual([["npm", "run", "build"]]);
  });

  it("adds lint/test only when the flag is on AND the script exists", () => {
    writePkg({ build: "tsc", lint: "eslint .", test: "vitest run" });
    expect(buildAcceptanceCommandsStrict(dir, { lint: true, test: true })).toEqual([
      ["npm", "run", "build"],
      ["npm", "run", "lint"],
      ["npm", "test"],
    ]);
    // flags off → build only
    expect(buildAcceptanceCommandsStrict(dir)).toEqual([["npm", "run", "build"]]);
  });

  it("skips the npm placeholder test script", () => {
    writePkg({ test: 'echo "Error: no test specified" && exit 1' });
    expect(buildAcceptanceCommandsStrict(dir, { test: true })).toEqual([]);
  });
});

describe("workspace snapshot edit-detection", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "mtv-snap-"));
    writeFileSync(join(dir, "a.txt"), "hello");
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src", "b.ts"), "export const x = 1;");
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("reports no change when nothing is touched", () => {
    const snap = snapshotWorkspace(dir);
    expect(workspaceChangedSince(dir, snap)).toBe(false);
  });

  it("detects a modified file (size changes)", () => {
    const snap = snapshotWorkspace(dir);
    writeFileSync(join(dir, "src", "b.ts"), "export const x = 1; // edited longer content");
    expect(workspaceChangedSince(dir, snap)).toBe(true);
  });

  it("detects an added file", () => {
    const snap = snapshotWorkspace(dir);
    writeFileSync(join(dir, "c.js"), "module.exports = 1;");
    expect(workspaceChangedSince(dir, snap)).toBe(true);
  });

  it("detects a deleted file", () => {
    const snap = snapshotWorkspace(dir);
    unlinkSync(join(dir, "a.txt"));
    expect(workspaceChangedSince(dir, snap)).toBe(true);
  });

  it("ignores heavy dirs like node_modules", () => {
    const snap = snapshotWorkspace(dir);
    mkdirSync(join(dir, "node_modules", "pkg"), { recursive: true });
    writeFileSync(join(dir, "node_modules", "pkg", "index.js"), "x");
    expect(workspaceChangedSince(dir, snap)).toBe(false);
  });
});

describe("verifyMainTurn flag resolution", () => {
  const KEYS = ["AGENCY_PROFILE", "AGENCY_VERIFY_LOOP", "AGENCY_VERIFY_MAIN_TURN", "AGENCY_VERIFY_MAX_ROUNDS"];
  let saved: Record<string, string | undefined>;
  beforeEach(() => {
    saved = {};
    for (const k of KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("defaults to verifyLoop (off legacy / on hardened)", () => {
    expect(getRuntimeFlags().verifyMainTurn).toBe(false);
    process.env.AGENCY_PROFILE = "hardened";
    expect(getRuntimeFlags().verifyMainTurn).toBe(true);
  });

  it("can be switched off independently while verifyLoop stays on", () => {
    process.env.AGENCY_PROFILE = "hardened";
    process.env.AGENCY_VERIFY_MAIN_TURN = "off";
    const f = getRuntimeFlags();
    expect(f.verifyLoop).toBe(true);
    expect(f.verifyMainTurn).toBe(false);
  });

  it("can be switched on independently in legacy", () => {
    process.env.AGENCY_VERIFY_MAIN_TURN = "on";
    const f = getRuntimeFlags();
    expect(f.verifyLoop).toBe(false);
    expect(f.verifyMainTurn).toBe(true);
  });
});

describe("verifyAndHeal main-turn contract", () => {
  const KEYS = ["AGENCY_VERIFY_LOOP", "AGENCY_VERIFY_MAIN_TURN", "AGENCY_VERIFY_MAX_ROUNDS"];
  let saved: Record<string, string | undefined>;
  let dir: string;

  beforeEach(() => {
    saved = {};
    for (const k of KEYS) {
      saved[k] = process.env[k];
    }
    process.env.AGENCY_VERIFY_LOOP = "1";
    process.env.AGENCY_VERIFY_MAIN_TURN = "1";
    process.env.AGENCY_VERIFY_MAX_ROUNDS = "2";
    dir = mkdtempSync(join(tmpdir(), "mtv-verify-"));
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ name: "x", scripts: { build: "node -e \"process.exit(1)\"" } })
    );
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    EventBus.getInstance().clear();
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  const fakeResult = {
    route: { intent: "edit", skills: [], workflow: "plan", agent: "planner", provider: "local" },
    routeSummary: "route",
    assistantText: "done",
    suggestedCommands: [],
    routeOnly: false,
    budget: "normal",
    contextFiles: [],
    routeFromCache: false,
  } as any;

  it("honors noVerify even when verify flags and failing scripts are enabled", async () => {
    let calls = 0;
    const result = await verifyAndHeal(
      { prompt: "edit", projectRoot: dir, skillsRoot: dir, noVerify: true },
      async () => {
        calls++;
        writeFileSync(join(dir, "changed.txt"), `round ${calls}`);
        return fakeResult;
      }
    );

    expect(result).toBe(fakeResult);
    expect(calls).toBe(1);
  });

  it("re-runs and emits verify-failed when acceptance keeps failing", async () => {
    let calls = 0;

    await verifyAndHeal(
      { prompt: "edit", projectRoot: dir, skillsRoot: dir },
      async () => {
        calls++;
        writeFileSync(join(dir, "changed.txt"), `round ${calls}`);
        return fakeResult;
      }
    );

    const failedEvents = EventBus.getInstance()
      .getJournal()
      .filter((event) => event.action === "chat:verify-failed")
      .map((event) => JSON.parse(event.payload));
    expect(calls).toBe(2);
    expect(failedEvents).toHaveLength(1);
    expect(failedEvents[0].rounds).toBe(2);
  });
});
