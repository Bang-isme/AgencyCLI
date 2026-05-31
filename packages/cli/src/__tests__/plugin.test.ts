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

function runCliWithSkills(args: string[], skillsRoot: string) {
  return spawnSync(process.execPath, [CLI_ENTRY, ...args], {
    env: { ...process.env, AGENCY_SKILLS_ROOT: skillsRoot },
    encoding: "utf8",
  });
}

describe("agency plugin", () => {
  it("tools exports JSON with pack_health", () => {
    if (!existsSync(CLI_ENTRY)) {
      throw new Error(`Build CLI first: pnpm --filter @agency/cli build (${CLI_ENTRY})`);
    }

    const result = runCli(["plugin", "tools"]);
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout.trim()) as {
      schema_version?: string;
      tools?: { name: string }[];
    };
    expect(parsed.schema_version).toBe("1.0");
    expect(parsed.tools?.some((t) => t.name === "pack_health")).toBe(true);
  });

  it("schema prints plugin-tools.schema.json path", () => {
    if (!existsSync(CLI_ENTRY)) {
      throw new Error(`Build CLI first: pnpm --filter @agency/cli build (${CLI_ENTRY})`);
    }

    const result = runCli(["plugin", "schema"]);
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toContain("plugin-tools.schema.json");
    expect(result.stdout.trim()).toContain(".system");
  });

  it("validate runs builtin script and exits 0", () => {
    if (!existsSync(CLI_ENTRY)) {
      throw new Error(`Build CLI first: pnpm --filter @agency/cli build (${CLI_ENTRY})`);
    }

    const result = runCli(["plugin", "validate"]);
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout.trim()) as { status?: string };
    expect(parsed.status).toBe("pass");
  });

  it("validates the bundled plugin root when using packaged skills", () => {
    if (!existsSync(CLI_ENTRY)) {
      throw new Error(`Build CLI first: pnpm --filter @agency/cli build (${CLI_ENTRY})`);
    }

    const bundledSkills = join(PKG_ROOT, "skills");
    const result = runCliWithSkills(["plugin", "validate"], bundledSkills);
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout.trim()) as { status?: string };
    expect(parsed.status).toBe("pass");
  });
});
