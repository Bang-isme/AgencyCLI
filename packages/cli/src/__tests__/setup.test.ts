import {
  existsSync,
  mkdirSync,
  mkdtempSync,
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

describe("agency setup", () => {
  it("indexes project and prints checklist", () => {
    if (!existsSync(CLI_ENTRY)) {
      throw new Error("Build CLI first");
    }

    const project = mkdtempSync(join(tmpdir(), "agency-setup-proj-"));
    const home = mkdtempSync(join(tmpdir(), "agency-setup-home-"));
    dirs.push(project, home);

    mkdirSync(project, { recursive: true });
    writeFileSync(join(project, "package.json"), "{}", "utf8");

    const result = spawnSync(
      process.execPath,
      [CLI_ENTRY, "setup", "--project-root", project],
      {
        encoding: "utf8",
        env: { ...process.env, HOME: home, USERPROFILE: home },
      }
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("indexedFiles=");
    expect(existsSync(join(project, ".agency", "index.json"))).toBe(true);
  });
});
