import { describe, expect, it, vi, beforeEach } from "vitest";
import type { RouteResult } from "../router/model-router.js";

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
import {
  buildSuggestedCommands,
  runChatTurn,
} from "../chat/orchestrator.js";

const mockedRouteUserPrompt = vi.mocked(routeUserPrompt);
const mockedLoadAgencyConfig = vi.mocked(providers.loadAgencyConfig);
const mockedGetProvider = vi.mocked(providers.getProvider);
const mockedUpdateModelOverride = vi.mocked(providers.updateModelOverride);

const baseRoute: RouteResult = {
  intent: "debug",
  suggested_agent: "debugger",
  workflow: "fix",
  skills: ["codex-systematic-debugging", "codex-test-driven-development"],
  provider: "anthropic",
  warnings: [],
};

const input = {
  prompt: "fix flaky auth test",
  projectRoot: "/proj",
  skillsRoot: "/skills",
};

beforeEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  clearRouteCache(input.projectRoot);
  mockedRouteUserPrompt.mockResolvedValue(baseRoute);
});

describe("buildSuggestedCommands", () => {
  it("includes workflow, agent dispatch, and skill invoke actions", () => {
    const commands = buildSuggestedCommands(
      baseRoute,
      input.projectRoot,
      input.prompt
    );
    expect(commands[0]).toBe("agency workflow run fix --project-root .");
    expect(commands).toContain(
      'agency agents dispatch debugger --task "fix flaky auth test"'
    );
    expect(commands).toContain("agency skill show codex-systematic-debugging");
  });

  it("skips agency route suggestion when prompt is empty", () => {
    const commands = buildSuggestedCommands(
      { ...baseRoute, skills: [], suggested_agent: null },
      input.projectRoot,
      "   "
    );
    expect(commands).not.toContain('agency route ""');
    expect(commands[0]).toBe("agency workflow run fix --project-root .");
  });

  it("omits agent dispatch when suggested_agent is null", () => {
    const commands = buildSuggestedCommands(
      { ...baseRoute, suggested_agent: null },
      input.projectRoot,
      input.prompt
    );
    expect(commands[0]).toBe("agency workflow run fix --project-root .");
    expect(commands).not.toContain("agency agents dispatch");
    expect(commands).toContain("agency skill show codex-systematic-debugging");
  });
});

describe("runChatTurn", () => {
  it("calls LLM when provider has apiKey and appends suggested commands", async () => {
    const complete = vi.fn().mockResolvedValue("Run the fix workflow first.");
    mockedLoadAgencyConfig.mockReturnValue({
      defaultProvider: "anthropic",
      providers: { anthropic: { apiKey: "sk-test" } },
    });
    mockedGetProvider.mockReturnValue({
      id: "anthropic",
      complete,
    });

    const result = await runChatTurn(input);

    expect(mockedRouteUserPrompt).toHaveBeenCalledWith(
      "/skills",
      "fix flaky auth test",
      "/proj"
    );
    expect(complete).toHaveBeenCalledWith(
      [
        {
          role: "system",
          content: expect.stringContaining("You are Agency CLI"),
        },
        { role: "user", content: "fix flaky auth test" },
      ],
      expect.objectContaining({ maxTokens: expect.any(Number) })
    );
    expect(result.budget).toBe("normal");
    expect(result.route).toEqual(baseRoute);
    expect(result.routeSummary).toContain("intent: debug");
    expect(result.routeOnly).toBe(false);
    expect(result.suggestedCommands[0]).toContain("agency workflow run fix");
    expect(result.assistantText).toContain("Run the fix workflow first.");
  });

  it("returns route JSON without LLM when apiKey is missing", async () => {
    mockedLoadAgencyConfig.mockReturnValue({
      defaultProvider: "anthropic",
      providers: {},
    });

    const result = await runChatTurn(input);

    expect(mockedGetProvider).not.toHaveBeenCalled();
    expect(result.routeOnly).toBe(true);
    expect(result.routeSummary).toContain("intent: debug");
    expect(result.assistantText).toContain("intent: debug");
    expect(result.assistantText).not.toContain('"intent": "debug"');
    expect(result.suggestedCommands.length).toBeGreaterThan(0);
  });

  it("skips LLM when noLlm is set even with apiKey", async () => {
    const complete = vi.fn();
    mockedLoadAgencyConfig.mockReturnValue({
      defaultProvider: "openrouter",
      providers: { openrouter: { apiKey: "or-key" } },
    });
    mockedGetProvider.mockReturnValue({ id: "openrouter", complete });

    const result = await runChatTurn({
      ...input,
      providerId: "openrouter",
      noLlm: true,
    });

    expect(complete).not.toHaveBeenCalled();
    expect(result.routeOnly).toBe(true);
    expect(result.assistantText).toContain("intent: debug");
    expect(result.assistantText).not.toContain('"intent": "debug"');
  });

  it("honors providerId override for LLM", async () => {
    const complete = vi.fn().mockResolvedValue("ok");
    mockedLoadAgencyConfig.mockReturnValue({
      defaultProvider: "anthropic",
      providers: {
        anthropic: { apiKey: "a" },
        openrouter: { apiKey: "or" },
      },
    });
    mockedGetProvider.mockReturnValue({ id: "openrouter", complete });

    await runChatTurn({ ...input, providerId: "openrouter" });

    expect(mockedGetProvider).toHaveBeenCalledWith(
      expect.objectContaining({ defaultProvider: "anthropic" }),
      "openrouter"
    );
  });

  it("automatically recovers from context limit error with decay and retry", async () => {
    mockedLoadAgencyConfig.mockReturnValue({
      defaultProvider: "openrouter",
      providers: { openrouter: { apiKey: "key", model: "gpt-4o-mini" } },
    });

    let calls = 0;
    const mockComplete = vi.fn(async () => {
      calls++;
      if (calls === 1) {
        throw new Error("maximum context length is 128000 tokens. However, you requested 130000 tokens.");
      }
      return "Success after healing in orchestrator";
    });

    mockedGetProvider.mockReturnValue({
      id: "openrouter",
      complete: mockComplete,
    });

    const result = await runChatTurn({ ...input, providerId: "openrouter" });

    expect(calls).toBe(2);
    expect(mockedUpdateModelOverride).toHaveBeenCalledWith("gpt-4o-mini", {
      contextWindow: 102400, // 128000 * 0.8
    });
    expect(result.assistantText).toBe("Success after healing in orchestrator");
  });

  it("bubbles up error if context window is at the safety floor and still errors", async () => {
    mockedLoadAgencyConfig.mockReturnValue({
      defaultProvider: "openrouter",
      providers: { openrouter: { apiKey: "key", model: "gpt-4o-mini" } },
    });

    // Mock getModelSpec to return a context window at or below floor
    vi.spyOn(providers, "getModelSpec").mockReturnValue({
      contextWindow: 8192,
      maxOutputTokens: 2048,
      thinkingType: "none",
    });

    const mockComplete = vi.fn(async () => {
      throw new Error("context_length_exceeded limit of 8192 tokens");
    });

    mockedGetProvider.mockReturnValue({
      id: "openrouter",
      complete: mockComplete,
    });

    await expect(runChatTurn({ ...input, providerId: "openrouter" })).rejects.toThrow("context_length_exceeded");

    // Should not have updated the override since it was already at the floor
    expect(mockedUpdateModelOverride).not.toHaveBeenCalled();
  });
});
