import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const PKG_ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "../..");
const CLI_ENTRY = join(PKG_ROOT, "dist", "index.js");

describe("agency benchmark CLI", () => {
  it("should list available benchmark tasks in table format", () => {
    if (!existsSync(CLI_ENTRY)) {
      throw new Error(`Build CLI first: pnpm --filter @agency/cli build (${CLI_ENTRY})`);
    }

    const result = spawnSync(
      process.execPath,
      [CLI_ENTRY, "benchmark", "--list"],
      { encoding: "utf8" }
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Available Benchmark Tasks:");
    expect(result.stdout).toContain("file-analysis");
    expect(result.stdout).toContain("ast-search");
  });

  it("should list available benchmark tasks in JSON format", () => {
    if (!existsSync(CLI_ENTRY)) {
      throw new Error(`Build CLI first: pnpm --filter @agency/cli build (${CLI_ENTRY})`);
    }

    const result = spawnSync(
      process.execPath,
      [CLI_ENTRY, "benchmark", "--list", "--json"],
      { encoding: "utf8" }
    );

    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout.trim());
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed[0].id).toBe("file-analysis");
  });

  it("should run file-analysis task and output results in table format", () => {
    if (!existsSync(CLI_ENTRY)) {
      throw new Error(`Build CLI first: pnpm --filter @agency/cli build (${CLI_ENTRY})`);
    }

    const result = spawnSync(
      process.execPath,
      [CLI_ENTRY, "benchmark", "file-analysis"],
      { encoding: "utf8" }
    );

    expect(result.status).toBe(0);
    expect(result.stderr).toContain("Running benchmark task 'File Analysis Task'...");
    expect(result.stdout).toContain("Benchmark Results:");
    expect(result.stdout).toContain("file-analysis");
    expect(result.stdout).toContain("YES");
  });

  it("should run file-analysis task and output results in raw JSON to stdout", () => {
    if (!existsSync(CLI_ENTRY)) {
      throw new Error(`Build CLI first: pnpm --filter @agency/cli build (${CLI_ENTRY})`);
    }

    const result = spawnSync(
      process.execPath,
      [CLI_ENTRY, "benchmark", "file-analysis", "--json"],
      { encoding: "utf8" }
    );

    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout.trim());
    expect(parsed.taskId).toBe("file-analysis");
    expect(parsed.success).toBe(true);
    expect(parsed.costUsd).toBe(0);
  });
});
