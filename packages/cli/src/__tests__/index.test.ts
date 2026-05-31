import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const PKG_ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "../..");
const CLI_ENTRY = join(PKG_ROOT, "dist", "index.js");

const dirs: string[] = [];

afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs.length = 0;
});

describe("agency index", () => {
  it("writes index under --project-root", () => {
    if (!existsSync(CLI_ENTRY)) {
      throw new Error(`Build CLI first: pnpm --filter @agency/cli build`);
    }

    const root = mkdtempSync(join(tmpdir(), "agency-index-"));
    dirs.push(root);
    const nested = join(root, "pkg");
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(nested, "package.json"), "{}", "utf8");
    writeFileSync(join(nested, "main.ts"), "export {}", "utf8");

    const result = spawnSync(
      process.execPath,
      [CLI_ENTRY, "index", "--project-root", nested],
      { encoding: "utf8" }
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Indexed");
    const indexPath = join(nested, ".agency", "index.json");
    expect(existsSync(indexPath)).toBe(true);
    const parsed = JSON.parse(readFileSync(indexPath, "utf8")) as {
      files: { path: string }[];
    };
    expect(parsed.files.some((f) => f.path === "main.ts")).toBe(true);
  });
});
