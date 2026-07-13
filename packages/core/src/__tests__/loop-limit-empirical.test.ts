import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RouteResult } from "../router/model-router.js";
import { z } from "zod";

vi.mock("../router/model-router.js", () => ({
  routeUserPrompt: vi.fn(),
}));

vi.mock("@agency/providers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@agency/providers")>();
  return {
    ...actual,
    loadAgencyConfig: vi.fn(),
    getProvider: vi.fn(),
    updateModelOverride: vi.fn(),
  };
});

import * as providers from "@agency/providers";
import { routeUserPrompt } from "../router/model-router.js";
import { clearRouteCache } from "../context/session-cache.js";
import { runChatTurn } from "../chat/orchestrator.js";
import { closeAllDbs } from "@agency/memory";
import { registry } from "../skill/tool-harness.js";
import { defaultMaxLoops } from "../chat/turn-helpers.js";

const mockedRoute = vi.mocked(routeUserPrompt);
const mockedConfig = vi.mocked(providers.loadAgencyConfig);
const mockedGetProvider = vi.mocked(providers.getProvider);

const route: RouteResult = {
  intent: "build",
  suggested_agent: null,
  workflow: "implement",
  skills: [],
  provider: "openrouter",
  warnings: [],
};

// Register dummy_tool safely
try {
  registry.register({
    name: "dummy_tool",
    description: "A dummy tool for testing loop limits.",
    category: "read",
    schema: z.object({
      val: z.string(),
    }),
    execute: async (args: any) => {
      return `Success: ${args.val}`;
    },
    metadata: {
      semanticAction: "Run dummy tool",
      targetExtractor: (args: any) => args.val || "",
      resultSummarizer: (_args: any, result: any) => String(result),
      risk: "low",
      prerequisite: "none",
      recovery: "Try again.",
    },
  });
} catch (e) {
  // Already registered
}

describe("Milestone 8 Loop Limits & Circuit Breaker Empirical Verification", () => {
  let root: string;

  beforeEach(() => {
    vi.clearAllMocks();
    root = mkdtempSync(join(tmpdir(), "agency-loop-limit-"));
    clearRouteCache(root);
    mockedRoute.mockResolvedValue(route);
    mockedConfig.mockReturnValue({
      defaultProvider: "openrouter",
      providers: { openrouter: { apiKey: "key", model: "gpt-4o-mini" } },
    });
  });

  afterEach(() => {
    closeAllDbs();
    if (existsSync(root)) rmSync(root, { recursive: true, force: true });
    delete process.env.AGENCY_MAX_LOOPS;
    delete process.env.AGENCY_CIRCUIT_BREAKER_THRESHOLD;
  });

  it("1. Verifies budget-specific defaults: deep = 25, normal = 25", () => {
    expect(defaultMaxLoops("deep")).toBe(25);
    expect(defaultMaxLoops("normal")).toBe(25);
    expect(defaultMaxLoops("fast")).toBe(3);
  });

  it("2. Verifies loop runs up to 25 steps under deep budget without circuit breaker tripping", async () => {
    let n = 0;
    const provider = {
      id: "openrouter" as const,
      complete: vi.fn(async () => {
        n++;
        return `<tool_call name="dummy_tool">\n  <val>step-${n}</val>\n</tool_call>`;
      }),
    };
    mockedGetProvider.mockReturnValue(provider);

    const result = await runChatTurn({
      prompt: "run long process",
      projectRoot: root,
      skillsRoot: "/skills",
      sessionId: "s-deep",
      budget: "deep",
      noVerify: true,
    });

    // It should run exactly 25 steps and then hit the max loop limit (resolves to 25).
    expect(provider.complete).toHaveBeenCalledTimes(25);
    expect(result.assistantText).toContain("Reached the maximum 25 tool/continuation iterations");
  });

  it("3. Verifies loop successfully runs up to 30 steps when overridden via AGENCY_MAX_LOOPS", async () => {
    process.env.AGENCY_MAX_LOOPS = "30";
    let n = 0;
    const provider = {
      id: "openrouter" as const,
      complete: vi.fn(async () => {
        n++;
        return `<tool_call name="dummy_tool">\n  <val>step-${n}</val>\n</tool_call>`;
      }),
    };
    mockedGetProvider.mockReturnValue(provider);

    const result = await runChatTurn({
      prompt: "run longer process",
      projectRoot: root,
      skillsRoot: "/skills",
      sessionId: "s-overridden",
      budget: "deep",
      noVerify: true,
    });

    // It should run exactly 30 steps because of the AGENCY_MAX_LOOPS environment variable.
    expect(provider.complete).toHaveBeenCalledTimes(30);
    expect(result.assistantText).toContain("Reached the maximum 30 tool/continuation iterations");
  });

  it("4. Verifies circuit breaker triggers correctly when threshold is exceeded (identical calls)", async () => {
    process.env.AGENCY_CIRCUIT_BREAKER_THRESHOLD = "3";
    const provider = {
      id: "openrouter" as const,
      complete: vi.fn(async () => {
        // Return same argument value every time
        return `<tool_call name="dummy_tool">\n  <val>constant-val</val>\n</tool_call>`;
      }),
    };
    mockedGetProvider.mockReturnValue(provider);

    const result = await runChatTurn({
      prompt: "run duplicate process",
      projectRoot: root,
      skillsRoot: "/skills",
      sessionId: "s-breaker-ident",
      budget: "deep",
      noVerify: true,
    });

    // With threshold = 3, identical call 1 (0 repeats), identical call 2 (1 repeat),
    // identical call 3 (2 repeats), identical call 4 (3 repeats -> trips!).
    // So complete is called 4 times.
    expect(provider.complete).toHaveBeenCalledTimes(4);
    expect(result.assistantText).toContain("Tool loop halted — Circuit breaker triggered");
    expect(result.assistantText).toContain("identical arguments");
  });
});
