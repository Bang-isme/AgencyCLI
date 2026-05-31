import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const PKG_ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "../..");
const CLI_ENTRY = join(PKG_ROOT, "dist", "index.js");

describe("agency run", () => {
  it("runs echo ok with --yes on Windows", () => {
    if (!existsSync(CLI_ENTRY)) {
      throw new Error(`Build CLI first: pnpm --filter @agency/cli build (${CLI_ENTRY})`);
    }

    const result = spawnSync(
      process.execPath,
      [CLI_ENTRY, "run", "echo ok", "--yes"],
      { encoding: "utf8" }
    );

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("ok");
  });
});
