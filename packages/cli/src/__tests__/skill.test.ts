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

describe("agency skill", () => {
  it("lists skills from manifest", () => {
    if (!existsSync(CLI_ENTRY)) {
      throw new Error(`Build CLI first: pnpm --filter @agency/cli build (${CLI_ENTRY})`);
    }

    const result = runCli(["skill", "list"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("codex-demo");
    expect(result.stdout).toContain("$plan");
  });

  it("shows skill TL;DR for alias", () => {
    if (!existsSync(CLI_ENTRY)) {
      throw new Error(`Build CLI first: pnpm --filter @agency/cli build (${CLI_ENTRY})`);
    }

    const result = runCli(["skill", "show", "codex-demo"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("name: codex-demo");
    expect(result.stdout).toContain("## TL;DR");
    expect(result.stdout).toContain("Demo skill for unit tests");
  });

  it("invoke prints path and harness hint for $sdd", () => {
    if (!existsSync(CLI_ENTRY)) {
      throw new Error(`Build CLI first: pnpm --filter @agency/cli build (${CLI_ENTRY})`);
    }

    const result = runCli(["skill", "invoke", "$sdd"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("skill: codex-subagent-execution");
    expect(result.stdout).toContain("harness: long-runner");
    expect(result.stdout).toContain("checkpointEvery=1");
    expect(result.stdout).toContain("Next steps:");
    expect(result.stdout).toContain("agency agents dispatch planner");
  });

  it("invoke prints plan next steps for $plan", () => {
    if (!existsSync(CLI_ENTRY)) {
      throw new Error(`Build CLI first: pnpm --filter @agency/cli build (${CLI_ENTRY})`);
    }

    const result = runCli(["skill", "invoke", "$plan"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Next steps:");
    expect(
      result.stdout.includes("agency task start") ||
        result.stdout.includes('agency chat "create plan')
    ).toBe(true);
  });
});
