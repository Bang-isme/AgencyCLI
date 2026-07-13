import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
import { runChatTurnWithStream } from "../chat/stream.js";
import { closeAllDbs } from "@agency/memory";

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

// Generates a different write_file tool call at each iteration
// to avoid the identical-call circuit breaker, and writes a new file
// each time to demonstrate progression.
function progressiveWriter() {
  let calls = 0;
  return {
    id: "openrouter" as const,
    complete: vi.fn(async () => {
      calls++;
      return `Writing file:\n<tool_call name="write_file">\n  <path>file-${calls}.txt</path>\n  <content>content-${calls}</content>\n</tool_call>`;
    }),
  };
}

describe("Milestone 8: Loop budget and limit verification", () => {
  let root: string;

  beforeEach(() => {
    vi.clearAllMocks();
    root = mkdtempSync(join(tmpdir(), "agency-m8-limits-"));
    clearRouteCache(root);
    mockedRoute.mockResolvedValue(route);
    mockedConfig.mockReturnValue({
      defaultProvider: "openrouter",
      providers: { openrouter: { apiKey: "key", model: "gpt-4o-mini" } },
    });
    // Turn off Phase E (autoContinueOnExhaustion) so the loop stops exactly at maxLoops
    process.env.AGENCY_AUTO_CONTINUE_EXHAUSTION = "0";
    process.env.AGENCY_RESUME_CONTINUATION = "1";
  });

  afterEach(() => {
    closeAllDbs();
    if (existsSync(root)) rmSync(root, { recursive: true, force: true });
    delete process.env.AGENCY_AUTO_CONTINUE_EXHAUSTION;
    delete process.env.AGENCY_RESUME_CONTINUATION;
    delete process.env.AGENCY_MAX_LOOPS;
  });

  it("should successfully run up to 25 steps under deep budget, then halt at maxLoops (25)", async () => {
    const writer = progressiveWriter();
    mockedGetProvider.mockReturnValue(writer);

    const result = await runChatTurnWithStream(
      { prompt: "run a deep search task", projectRoot: root, skillsRoot: "/skills", sessionId: "sess-deep", budget: "deep" },
      { onRoute: () => {}, onDelta: () => {} }
    );

    // It should complete exactly 25 completions/steps
    expect(writer.complete).toHaveBeenCalledTimes(25);
    // The warning message should indicate it hit max loop limit 25
    expect(result.assistantText).toContain("[SYSTEM: Reached the maximum 25 tool/continuation iterations");
  });

  it("should successfully run up to 25 steps under normal budget, then halt at maxLoops (25)", async () => {
    const writer = progressiveWriter();
    mockedGetProvider.mockReturnValue(writer);

    const result = await runChatTurnWithStream(
      { prompt: "run a normal search task", projectRoot: root, skillsRoot: "/skills", sessionId: "sess-normal", budget: "normal" },
      { onRoute: () => {}, onDelta: () => {} }
    );

    // It should complete exactly 25 completions/steps
    expect(writer.complete).toHaveBeenCalledTimes(25);
    // The warning message should indicate it hit max loop limit 25
    expect(result.assistantText).toContain("[SYSTEM: Reached the maximum 25 tool/continuation iterations");
  });

  it("should successfully run up to 30 steps when AGENCY_MAX_LOOPS override is 30 and no circuit breaker trips", async () => {
    process.env.AGENCY_MAX_LOOPS = "30";
    const writer = progressiveWriter();
    mockedGetProvider.mockReturnValue(writer);

    const result = await runChatTurnWithStream(
      { prompt: "run a deep search task", projectRoot: root, skillsRoot: "/skills", sessionId: "sess-override", budget: "deep" },
      { onRoute: () => {}, onDelta: () => {} }
    );

    // It should complete exactly 30 completions/steps
    expect(writer.complete).toHaveBeenCalledTimes(30);
    expect(result.assistantText).toContain("[SYSTEM: Reached the maximum 30 tool/continuation iterations");
  });

  it("should trip the circuit breaker on repeated identical calls well before maxLoops when AGENCY_MAX_LOOPS is 30", async () => {
    process.env.AGENCY_MAX_LOOPS = "30";
    // Using default threshold 6, it should trip at 7th call (6 repeats)
    let calls = 0;
    const repeatingWriter = {
      id: "openrouter" as const,
      complete: vi.fn(async () => {
        calls++;
        return `Writing file:\n<tool_call name="write_file">\n  <path>same-file.txt</path>\n  <content>same-content</content>\n</tool_call>`;
      }),
    };
    mockedGetProvider.mockReturnValue(repeatingWriter);

    const result = await runChatTurnWithStream(
      { prompt: "write same file", projectRoot: root, skillsRoot: "/skills", sessionId: "sess-breaker", budget: "deep" },
      { onRoute: () => {}, onDelta: () => {} }
    );

    // Default threshold is 6 repeats, so it trips on 7th completion
    expect(repeatingWriter.complete).toHaveBeenCalledTimes(7);
    expect(result.assistantText).toContain("Tool loop halted");
    expect(result.assistantText).toContain("Circuit breaker triggered");
  });
});
