import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildAcceptanceCommandsStrict } from "../utils/package-manager.js";
import { snapshotWorkspace, workspaceChangedSince } from "../utils/workspace-snapshot.js";
import { getRuntimeFlags } from "../runtime/flags.js";

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
  const KEYS = ["AGENCY_PROFILE", "AGENCY_VERIFY_LOOP", "AGENCY_VERIFY_MAIN_TURN"];
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
