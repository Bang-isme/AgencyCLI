import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const PKG_ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "../..");
const CLI_ENTRY = join(PKG_ROOT, "dist", "index.js");

const homes: string[] = [];

afterEach(() => {
  for (const h of homes) rmSync(h, { recursive: true, force: true });
  homes.length = 0;
});

describe("agency config", () => {
  it("init writes config under HOME", () => {
    if (!existsSync(CLI_ENTRY)) throw new Error("Build CLI first");
    const home = mkdtempSync(join(tmpdir(), "agency-config-home-"));
    homes.push(home);

    const result = spawnSync(
      process.execPath,
      [CLI_ENTRY, "config", "init"],
      { encoding: "utf8", env: { ...process.env, HOME: home, USERPROFILE: home } }
    );

    expect(result.status).toBe(0);
    expect(existsSync(join(home, ".agency", "config.json"))).toBe(true);
    expect(result.stdout).toContain("config initialized");
  });
});
