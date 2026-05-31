import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("execa", () => ({
  execa: vi.fn(),
}));

import { execa } from "execa";
import { runBuiltinScript, runTool } from "../runner.js";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "../../../..");
const FIXTURE = join(ROOT, "tests", "fixtures", "mock-skills");

const mockedExeca = vi.mocked(execa);

afterEach(() => {
  vi.clearAllMocks();
});

describe("runTool", () => {
  it("throws for unknown tool", async () => {
    await expect(runTool(FIXTURE, "no_such_tool", [])).rejects.toThrow(
      "Unknown tool: no_such_tool"
    );
    expect(mockedExeca).not.toHaveBeenCalled();
  });

  it("runs the tool with a warning when writes_artifacts without yes", async () => {
    mockedExeca.mockResolvedValue({
      exitCode: 0,
      stdout: "warning-ok",
      stderr: "",
    } as Awaited<ReturnType<typeof execa>>);

    const result = await runTool(FIXTURE, "write_stub", []);
    expect(result.exitCode).toBe(0);
    expect(mockedExeca).toHaveBeenCalled();
  });

  it("runs python with registry script when approved", async () => {
    mockedExeca.mockResolvedValue({
      exitCode: 0,
      stdout: '{"ok":true}',
      stderr: "",
    } as Awaited<ReturnType<typeof execa>>);

    const result = await runTool(FIXTURE, "pack_health", ["--format", "json"], {
      yes: true,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('{"ok":true}');
    // The interpreter is resolved dynamically (python3 → python → py); the
    // mocked `--version` probe makes python3 the first to succeed.
    expect(mockedExeca).toHaveBeenCalledWith(
      "python3",
      [
        join(FIXTURE, ".system/scripts/check_pack_health.py"),
        "--format",
        "json",
      ],
      { cwd: undefined, reject: false }
    );
  });
});

describe("runBuiltinScript", () => {
  it("throws for unknown builtin", async () => {
    await expect(runBuiltinScript(FIXTURE, "no_such_builtin", [])).rejects.toThrow(
      "Unknown builtin: no_such_builtin"
    );
  });

  it("runs builtin without yes", async () => {
    mockedExeca.mockResolvedValue({
      exitCode: 0,
      stdout: "routed",
      stderr: "",
    } as Awaited<ReturnType<typeof execa>>);

    const result = await runBuiltinScript(FIXTURE, "prompt_route", ["hello"]);

    expect(result.exitCode).toBe(0);
    expect(mockedExeca).toHaveBeenCalledWith(
      "python3",
      [join(FIXTURE, ".system/scripts/prompt_router.py"), "hello"],
      { cwd: undefined, reject: false }
    );
  });
});

function resolveIntegrationSkillsRoot(): string | undefined {
  const candidates = [
    process.env.AGENCY_SKILLS_ROOT,
    join(homedir(), ".agency", "skills"),
    join(homedir(), ".cursor", "skills-cursor"),
    join(homedir(), ".codex", "skills"),
  ];
  for (const root of candidates) {
    if (root && existsSync(join(root, ".system", "manifest.json"))) {
      return root;
    }
  }
  return undefined;
}

const integrationRoot = resolveIntegrationSkillsRoot();
const scriptPath =
  integrationRoot &&
  join(integrationRoot, ".system/scripts/check_pack_health.py");
const canIntegrate =
  !!integrationRoot &&
  !!scriptPath &&
  existsSync(scriptPath);

describe.skipIf(!canIntegrate)("runTool integration", () => {
  it(
    "runs pack_health with json output",
    async () => {
      vi.doUnmock("execa");
      vi.resetModules();
      const { runTool: runToolLive } = await import("../runner.js");

      const result = await runToolLive(
        integrationRoot!,
        "pack_health",
        ["--skills-root", integrationRoot!, "--format", "json"],
        { yes: true }
      );

      const parsed = JSON.parse(result.stdout) as { status?: string };
      expect(parsed.status).toMatch(/^(pass|fail)$/);
      expect(typeof result.exitCode).toBe("number");
    },
    { timeout: 15_000 }
  );
});
