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
import { runChatTurn } from "../chat/orchestrator.js";
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

/** A provider that emits the SAME write_file call every completion → the breaker's
 *  identical-signature guard trips on the 4th call (3 repeats). */
function identicalWriter(path: string) {
  return {
    id: "openrouter" as const,
    complete: vi.fn(async () =>
      `<tool_call name="write_file">\n  <path>${path}</path>\n  <content>same chunk</content>\n</tool_call>`
    ),
  };
}

/** A provider that emits a DISTINCT (so the identical-signature guard never fires)
 *  but always-FAILING call every completion — an unknown tool → `Error: Unknown
 *  tool`. This is the user's screenshot case (refused taskkill variants): the
 *  consecutive-failure guard is the one that must catch it. */
function distinctFailer() {
  let n = 0;
  return {
    id: "openrouter" as const,
    complete: vi.fn(async () =>
      `<tool_call name="bogus_tool">\n  <attempt>${n++}</attempt>\n</tool_call>`
    ),
  };
}

describe("§8.8-A circuit-breaker hard-break (turn loop stops instead of churning)", () => {
  let root: string;

  beforeEach(() => {
    vi.clearAllMocks();
    root = mkdtempSync(join(tmpdir(), "agency-breaker-"));
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
  });

  it("stream: identical repeated calls trip the breaker → loop hard-breaks well before maxLoops", async () => {
    const provider = identicalWriter("page.html");
    mockedGetProvider.mockReturnValue(provider);

    const result = await runChatTurnWithStream(
      { prompt: "write page.html", projectRoot: root, skillsRoot: "/skills", sessionId: "s-rep", maxLoops: 10, noVerify: true },
      { onRoute: () => {}, onDelta: () => {} }
    );

    // Trips on the 4th identical call (3 repeats) → exactly 4 completions, NOT 10.
    expect(provider.complete).toHaveBeenCalledTimes(4);
    expect(result.assistantText).toContain("Tool loop halted");
    expect(result.assistantText).toContain("Circuit breaker triggered");
    expect(result.assistantText).toMatch(/identical arguments/i);
  });

  it("stream: consecutive failures (distinct refused calls) trip the breaker → loop hard-breaks (the screenshot case)", async () => {
    const provider = distinctFailer();
    mockedGetProvider.mockReturnValue(provider);

    const result = await runChatTurnWithStream(
      { prompt: "restart the dev server", projectRoot: root, skillsRoot: "/skills", sessionId: "s-fail", maxLoops: 10, noVerify: true },
      { onRoute: () => {}, onDelta: () => {} }
    );

    expect(provider.complete).toHaveBeenCalledTimes(4);
    expect(result.assistantText).toContain("Tool loop halted");
    expect(result.assistantText).toMatch(/consecutive tool execution failures/i);
  });

  it("non-stream: a breaker trip folds the halt notice into assistantText and stops the loop", async () => {
    const provider = identicalWriter("doc.md");
    mockedGetProvider.mockReturnValue(provider);

    const result = await runChatTurn({
      prompt: "write doc.md",
      projectRoot: root,
      skillsRoot: "/skills",
      sessionId: "s-plain",
      maxLoops: 10,
      noVerify: true,
    });

    expect(provider.complete).toHaveBeenCalledTimes(4);
    expect(result.assistantText).toContain("Tool loop halted");
    expect(result.assistantText).toContain("Circuit breaker triggered");
  });
});
