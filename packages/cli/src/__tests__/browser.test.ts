import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const PKG_ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "../..");
const REPO_ROOT = join(PKG_ROOT, "../..");
const CLI_ENTRY = join(PKG_ROOT, "dist", "index.js");
const FIXTURE = join(REPO_ROOT, "tests", "fixtures", "mock-skills");

function runCli(args: string[]) {
  return spawnSync(process.execPath, [CLI_ENTRY, ...args], {
    env: { ...process.env, AGENCY_SKILLS_ROOT: FIXTURE },
    encoding: "utf8",
  });
}

describe("agency browser", () => {
  it("status returns JSON with hint field", () => {
    if (!existsSync(CLI_ENTRY)) {
      throw new Error(`Build CLI first: pnpm --filter @agency/cli build (${CLI_ENTRY})`);
    }

    const result = runCli(["browser", "status"]);
    expect(result.status).toBe(0);

    const parsed = JSON.parse(result.stdout.trim()) as {
      configured?: boolean;
      hint?: string;
    };
    expect(typeof parsed.configured).toBe("boolean");
    expect(parsed.hint).toContain("cursor-ide-browser");
    expect(parsed.hint).toContain("Browser automation requires Cursor IDE Browser MCP");
  });
});
