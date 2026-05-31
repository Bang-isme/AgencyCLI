import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { buildAcceptanceCommands } from "../utils/package-manager.js";

let root = "";
afterEach(() => {
  if (root) {
    rmSync(root, { recursive: true, force: true });
    root = "";
  }
});

function withPkg(scripts: Record<string, string>): string {
  root = mkdtempSync(join(tmpdir(), "agency-accept-"));
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ packageManager: "pnpm@9.0.0", scripts })
  );
  return root;
}

describe("buildAcceptanceCommands", () => {
  it("returns build-only when no extras are requested (legacy parity)", () => {
    const p = withPkg({ build: "tsc", lint: "eslint .", test: "vitest run" });
    expect(buildAcceptanceCommands(p, {})).toEqual([["pnpm", "build"]]);
  });

  it("adds lint when requested and a lint script exists", () => {
    const p = withPkg({ build: "tsc", lint: "eslint ." });
    expect(buildAcceptanceCommands(p, { lint: true })).toEqual([
      ["pnpm", "build"],
      ["pnpm", "lint"],
    ]);
  });

  it("skips lint when no lint script exists", () => {
    const p = withPkg({ build: "tsc" });
    expect(buildAcceptanceCommands(p, { lint: true })).toEqual([["pnpm", "build"]]);
  });

  it("adds test when requested and a real test script exists", () => {
    const p = withPkg({ build: "tsc", test: "vitest run" });
    expect(buildAcceptanceCommands(p, { test: true })).toEqual([
      ["pnpm", "build"],
      ["pnpm", "test"],
    ]);
  });

  it("skips the npm placeholder test script", () => {
    const p = withPkg({ build: "tsc", test: 'echo "Error: no test specified" && exit 1' });
    expect(buildAcceptanceCommands(p, { test: true })).toEqual([["pnpm", "build"]]);
  });

  it("includes both lint and test when both are requested", () => {
    const p = withPkg({ build: "tsc", lint: "eslint .", test: "vitest run" });
    expect(buildAcceptanceCommands(p, { lint: true, test: true })).toEqual([
      ["pnpm", "build"],
      ["pnpm", "lint"],
      ["pnpm", "test"],
    ]);
  });
});
