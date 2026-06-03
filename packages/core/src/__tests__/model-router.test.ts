import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { saveWeights } from "../router/weights.js";

vi.mock("../router/prompt-bridge.js", () => ({
  routePrompt: vi.fn(),
}));

vi.mock("@agency/providers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@agency/providers")>();
  return {
    ...actual,
    loadAgencyConfig: vi.fn(),
  };
});

import { loadAgencyConfig } from "@agency/providers";
import { routePrompt } from "../router/prompt-bridge.js";
import { routeUserPrompt, skillsFromPromptAliases } from "../router/model-router.js";
import { heuristicRoute } from "../router/fallback-router.js";

const mockedRoutePrompt = vi.mocked(routePrompt);
const mockedLoadAgencyConfig = vi.mocked(loadAgencyConfig);

const SKILLS_ROOT = "/skills";

beforeEach(() => {
  mockedLoadAgencyConfig.mockReturnValue({
    defaultProvider: "anthropic",
    providers: {},
  });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("routeUserPrompt", () => {
  it("merges plugin route with default anthropic provider", async () => {
    mockedRoutePrompt.mockResolvedValue({
      intent: "debug",
      suggested_agent: null,
      workflow: "fix",
      skills: ["codex-systematic-debugging"],
      warnings: [],
    });

    const result = await routeUserPrompt(SKILLS_ROOT, "fix auth bug");

    expect(result).toEqual({
      intent: "debug",
      suggested_agent: null,
      workflow: "fix",
      skills: ["codex-systematic-debugging"],
      provider: "anthropic",
      warnings: [],
    });
    expect(mockedRoutePrompt).toHaveBeenCalledWith(SKILLS_ROOT, "fix auth bug");
  });

  it("reads provider from loadAgencyConfig", async () => {
    mockedRoutePrompt.mockResolvedValue({ intent: "other" });
    mockedLoadAgencyConfig.mockReturnValue({
      defaultProvider: "openai",
      providers: {},
    });

    const result = await routeUserPrompt(SKILLS_ROOT, "hello");

    expect(result.provider).toBe("openai");
  });

  it("falls back to anthropic when config uses default", async () => {
    mockedRoutePrompt.mockResolvedValue({});
    mockedLoadAgencyConfig.mockReturnValue({
      defaultProvider: "anthropic",
      providers: {},
    });

    const result = await routeUserPrompt(SKILLS_ROOT, "x");

    expect(result.provider).toBe("anthropic");
    expect(result.intent).toBe("other");
    expect(result.workflow).toBe("create");
    expect(result.skills).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it("falls back to heuristic routing when prompt_router throws (no Python)", async () => {
    mockedRoutePrompt.mockRejectedValue(new Error("Python interpreter not found"));

    const result = await routeUserPrompt(SKILLS_ROOT, "fix the login crash");

    // Heuristic classifies a "fix … crash" prompt as a debug route…
    expect(result.intent).toBe("debug");
    expect(result.suggested_agent).toBe("debugger");
    expect(result.provider).toBe("anthropic");
    // …and explains why it degraded.
    expect(
      result.warnings.some((w) => w.includes("heuristic routing"))
    ).toBe(true);
  });

  it("applies routing weights when projectRoot has weights file", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "agency-route-weights-"));
    try {
      saveWeights(projectRoot, {
        version: 1,
        signals: { debug: 10, other: 1 },
        feedback: [],
      });
      mockedRoutePrompt.mockResolvedValue({
        intent: "other",
        workflow: "create",
        warnings: [],
      });

      const result = await routeUserPrompt(
        SKILLS_ROOT,
        "please debug this failure",
        projectRoot
      );

      expect(result.intent).toBe("debug");
      expect(result.warnings.some((w) => w.includes("routing-weights"))).toBe(
        true
      );
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});

describe("skillsFromPromptAliases (explicit $alias → skill)", () => {
  it("resolves a known alias to its skill", () => {
    expect(skillsFromPromptAliases("$design make a landing page")).toEqual(["codex-design-system"]);
    expect(skillsFromPromptAliases("$tdd add a test")).toEqual(["codex-test-driven-development"]);
  });

  it("resolves hyphenated/multi aliases and dedupes", () => {
    expect(skillsFromPromptAliases("$check-full then $gate")).toEqual(["codex-execution-quality-gate"]);
    expect(skillsFromPromptAliases("$design and $security audit")).toEqual([
      "codex-design-system",
      "codex-security-specialist",
    ]);
  });

  it("ignores non-alias dollar tokens (no false positives)", () => {
    expect(skillsFromPromptAliases("it costs $5 and uses $PATH and $myvar")).toEqual([]);
    expect(skillsFromPromptAliases("no dollar here")).toEqual([]);
  });
});

describe("routeUserPrompt explicit-alias activation", () => {
  it("activates the chosen skill even when the fuzzy router picks another", async () => {
    // The intent router classifies "$design …" as a plan (codex-plan-writer),
    // but the explicit $design must still activate codex-design-system, first.
    mockedRoutePrompt.mockResolvedValue({
      intent: "other",
      workflow: "plan",
      skills: ["codex-plan-writer"],
      warnings: [],
    });

    const result = await routeUserPrompt(SKILLS_ROOT, "$design a hero section");

    expect(result.skills[0]).toBe("codex-design-system");
    expect(result.skills).toContain("codex-plan-writer");
  });

  it("leaves skills unchanged when no $alias is present", async () => {
    mockedRoutePrompt.mockResolvedValue({
      intent: "build",
      workflow: "create",
      skills: ["codex-test-driven-development"],
      warnings: [],
    });

    const result = await routeUserPrompt(SKILLS_ROOT, "build a dashboard");

    expect(result.skills).toEqual(["codex-test-driven-development"]);
  });
});

describe("routeUserPrompt workflow skill-chain activation", () => {
  function makeSkillsRootWithPlanWorkflow(): string {
    const skillsRoot = mkdtempSync(join(tmpdir(), "agency-wf-loads-"));
    mkdirSync(join(skillsRoot, ".workflows"), { recursive: true });
    writeFileSync(
      join(skillsRoot, ".workflows", "plan.md"),
      "---\nname: plan\ntrigger: $plan\nloads: [codex-intent-context-analyzer, codex-plan-writer, codex-reasoning-rigor]\n---\n# Workflow\n",
      "utf8"
    );
    return skillsRoot;
  }

  it("merges the selected workflow's declared loads: skills when the flag is on", async () => {
    const skillsRoot = makeSkillsRootWithPlanWorkflow();
    mockedRoutePrompt.mockResolvedValue({
      intent: "other",
      workflow: "plan",
      skills: ["codex-plan-writer"],
      warnings: [],
    });
    process.env.AGENCY_WORKFLOW_SKILL_LOADS = "1";
    try {
      const result = await routeUserPrompt(skillsRoot, "plan the feature");
      // The router's own skill keeps priority; the workflow's loads fill out the
      // rest of the declared pipeline, deduped (codex-plan-writer not repeated).
      expect(result.skills).toEqual([
        "codex-plan-writer",
        "codex-intent-context-analyzer",
        "codex-reasoning-rigor",
      ]);
    } finally {
      delete process.env.AGENCY_WORKFLOW_SKILL_LOADS;
      rmSync(skillsRoot, { recursive: true, force: true });
    }
  });

  it("does NOT merge workflow loads when the flag is off (legacy byte-identical)", async () => {
    const skillsRoot = makeSkillsRootWithPlanWorkflow();
    mockedRoutePrompt.mockResolvedValue({
      intent: "other",
      workflow: "plan",
      skills: ["codex-plan-writer"],
      warnings: [],
    });
    process.env.AGENCY_WORKFLOW_SKILL_LOADS = "0";
    try {
      const result = await routeUserPrompt(skillsRoot, "plan the feature");
      expect(result.skills).toEqual(["codex-plan-writer"]);
    } finally {
      delete process.env.AGENCY_WORKFLOW_SKILL_LOADS;
      rmSync(skillsRoot, { recursive: true, force: true });
    }
  });
});

describe("heuristicRoute", () => {
  it("routes security prompts to a review by the security-auditor", () => {
    const r = heuristicRoute("find the security vulnerability in auth", "openai");
    expect(r.intent).toBe("review");
    expect(r.workflow).toBe("review");
    expect(r.suggested_agent).toBe("security-auditor");
    expect(r.provider).toBe("openai");
  });

  it("routes bug prompts to debug", () => {
    const r = heuristicRoute("fix the traceback when API auth fails", "anthropic");
    expect(r.intent).toBe("debug");
    expect(r.suggested_agent).toBe("debugger");
  });

  it("routes frontend build prompts to frontend-specialist", () => {
    const r = heuristicRoute("build a React dashboard", "anthropic");
    expect(r.intent).toBe("build");
    expect(r.suggested_agent).toBe("frontend-specialist");
    expect(r.workflow).toBe("create");
  });

  it("routes backend build prompts to backend-specialist", () => {
    const r = heuristicRoute("create a backend API endpoint", "anthropic");
    expect(r.intent).toBe("build");
    expect(r.suggested_agent).toBe("backend-specialist");
  });

  it("returns a neutral route for empty/unknown prompts", () => {
    expect(heuristicRoute("", "anthropic")).toMatchObject({
      intent: "other",
      suggested_agent: null,
      workflow: "create",
      skills: [],
    });
  });
});
