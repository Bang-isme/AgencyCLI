import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const PKG_ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "../..");
const REPO_ROOT = join(PKG_ROOT, "../..");
const CLI_ENTRY = join(PKG_ROOT, "dist", "index.js");
const FIXTURE = join(REPO_ROOT, "tests", "fixtures", "mock-skills");

describe("agency doctor", () => {
  it("prints a TS-native preflight report (python, skills-pack, providers)", () => {
    if (!existsSync(CLI_ENTRY)) {
      throw new Error(`Build CLI first: pnpm --filter @agency/cli build (${CLI_ENTRY})`);
    }

    const result = spawnSync(process.execPath, [CLI_ENTRY, "doctor", "--json"], {
      env: { ...process.env, AGENCY_SKILLS_ROOT: FIXTURE },
      encoding: "utf8",
    });

    // Exit 0 when a provider is ready, 1 when none is — both are valid here
    // since the test runner's HOME config is not controlled.
    expect([0, 1]).toContain(result.status);

    const parsed = JSON.parse(result.stdout.trim()) as {
      ok: boolean;
      checks: { name: string; status: string }[];
    };
    expect(typeof parsed.ok).toBe("boolean");
    expect(Array.isArray(parsed.checks)).toBe(true);

    const names = parsed.checks.map((c) => c.name);
    expect(names).toContain("python");
    expect(names).toContain("skills-pack");
    expect(names).toContain("providers");
  });
});
