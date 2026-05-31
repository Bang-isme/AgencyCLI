import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const PKG_ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "../..");
const CLI_ENTRY = join(PKG_ROOT, "dist", "index.js");

function runCli(args: string[], cwd: string) {
  if (!existsSync(CLI_ENTRY)) {
    throw new Error(`Build CLI first: pnpm --filter @agency/cli build (${CLI_ENTRY})`);
  }
  return spawnSync(process.execPath, [CLI_ENTRY, ...args], {
    cwd,
    encoding: "utf8",
  });
}

describe("agency team", () => {
  it("init, show, and member add via CLI", () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "agency-cli-team-"));
    try {
      const init = runCli(
        ["team", "init", "--name", "My Team", "--project-root", projectRoot],
        projectRoot
      );
      expect(init.status).toBe(0);
      const initJson = JSON.parse(init.stdout.trim()) as { teamName: string };
      expect(initJson.teamName).toBe("My Team");

      const show = runCli(["team", "show", "--project-root", projectRoot], projectRoot);
      expect(show.status).toBe(0);
      const showJson = JSON.parse(show.stdout.trim()) as { members: unknown[] };
      expect(showJson.members).toEqual([]);

      const add = runCli(
        [
          "team",
          "member",
          "add",
          "--id",
          "u1",
          "--name",
          "Alice",
          "--role",
          "dev",
          "--project-root",
          projectRoot,
        ],
        projectRoot
      );
      expect(add.status).toBe(0);
      const addJson = JSON.parse(add.stdout.trim()) as {
        members: { id: string; name: string }[];
      };
      expect(addJson.members).toHaveLength(1);
      expect(addJson.members[0]?.id).toBe("u1");
      expect(addJson.members[0]?.name).toBe("Alice");
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});
