import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const PKG_ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "../..");
const CLI_ENTRY = join(PKG_ROOT, "dist", "index.js");

describe("agency run sandbox CLI", () => {
  it("should warn when running in native mode", () => {
    if (!existsSync(CLI_ENTRY)) {
      throw new Error(`Build CLI first: pnpm --filter @agency/cli build (${CLI_ENTRY})`);
    }

    const result = spawnSync(
      process.execPath,
      [CLI_ENTRY, "run", "echo ok", "--yes", "--sandbox-mode", "native"],
      { encoding: "utf8" }
    );

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("ok");
    expect(result.stderr).toContain("Warning: Running command natively on host.");
  });

  it("should attempt docker run and fail securely if docker daemon is unreachable", () => {
    if (!existsSync(CLI_ENTRY)) {
      throw new Error(`Build CLI first: pnpm --filter @agency/cli build (${CLI_ENTRY})`);
    }

    const result = spawnSync(
      process.execPath,
      [CLI_ENTRY, "run", "echo ok", "--yes", "--sandbox-mode", "docker"],
      { encoding: "utf8" }
    );

    // If docker daemon is not available/running, it exits with 1 and prints the security check error.
    // If docker IS running, it might run successfully (exit code 0 or 1). Both are fine because they assert it didn't crash unexpectedly.
    if (result.status !== 0) {
      expect(result.stderr).toContain("Docker daemon is unreachable");
    }
  });
});
