import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@agency/skills-bridge", () => ({
  runBuiltinScript: vi.fn(),
}));

import { runBuiltinScript } from "@agency/skills-bridge";
import { routePrompt } from "../router/prompt-bridge.js";

const mockedRunBuiltin = vi.mocked(runBuiltinScript);

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "../../../..");
const FIXTURE = join(ROOT, "tests", "fixtures", "mock-skills");

afterEach(() => {
  vi.clearAllMocks();
});

describe("routePrompt", () => {
  it("parses JSON from prompt_route builtin", async () => {
    mockedRunBuiltin.mockResolvedValue({
      exitCode: 0,
      stdout: JSON.stringify({ intent: "debug", workflow: "fix" }),
      stderr: "",
    });

    const result = await routePrompt(FIXTURE, "fix auth bug");

    expect(result).toEqual({ intent: "debug", workflow: "fix" });
    expect(mockedRunBuiltin).toHaveBeenCalledWith(FIXTURE, "prompt_route", [
      "--prompt",
      "fix auth bug",
      "--format",
      "json",
    ]);
  });

  it("throws when builtin exits non-zero", async () => {
    mockedRunBuiltin.mockResolvedValue({
      exitCode: 1,
      stdout: "router error",
      stderr: "",
    });

    await expect(routePrompt(FIXTURE, "bad")).rejects.toThrow(
      "prompt_router failed: router error"
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
    if (
      root &&
      existsSync(join(root, ".system", "manifest.json")) &&
      existsSync(join(root, ".system/scripts/prompt_router.py"))
    ) {
      return root;
    }
  }
  const fixtureScript = join(FIXTURE, ".system/scripts/prompt_router.py");
  if (existsSync(fixtureScript)) return FIXTURE;
  return undefined;
}

const integrationRoot = resolveIntegrationSkillsRoot();
const canIntegrate = !!integrationRoot;

describe.skipIf(!canIntegrate)("routePrompt integration", () => {
  it("runs prompt_router when skills pack is available", async () => {
    vi.doUnmock("@agency/skills-bridge");
    vi.resetModules();
    const { routePrompt: routePromptLive } = await import("../router/prompt-bridge.js");

    const result = await routePromptLive(integrationRoot!, "fix auth bug");

    expect(typeof result.intent).toBe("string");
    // Spawns the Python prompt_router; ~5s cold-start sits right on the default
    // 5000ms limit and tips over under the concurrent `pnpm -r test` load → widen.
  }, 20000);
});
