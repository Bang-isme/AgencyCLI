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
import { detectIncompleteCompletion, MAX_AUTO_CONTINUE } from "../chat/turn-helpers.js";
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

describe("detectIncompleteCompletion (pure)", () => {
  it("fires on an end-of-message first-person continuation promise", () => {
    expect(
      detectIncompleteCompletion("I've set up the structure. I'll now implement the remaining handlers.")
    ).toBe(true);
    expect(detectIncompleteCompletion("Next, I'll create the config file and wire it up.")).toBe(true);
    expect(detectIncompleteCompletion("Good progress so far. Let me continue with the routes.")).toBe(true);
  });

  it("fires on an explicit 'to be continued' marker", () => {
    expect(detectIncompleteCompletion("Part 1 done. (to be continued)")).toBe(true);
  });

  it("fires on a left-in code placeholder regardless of surrounding text", () => {
    expect(
      detectIncompleteCompletion("```js\nfunction f() {\n  // ... rest of the code\n}\n```")
    ).toBe(true);
    expect(detectIncompleteCompletion("# ... remaining implementation below")).toBe(true);
  });

  it("does NOT fire on a genuinely-complete turn", () => {
    expect(detectIncompleteCompletion("Here's the full solution. The implementation is complete.")).toBe(false);
    expect(detectIncompleteCompletion("Done — all files created and the build passes.")).toBe(false);
    expect(detectIncompleteCompletion("")).toBe(false);
  });

  it("does NOT fire on an offer/question to the user (not an in-progress promise)", () => {
    expect(detectIncompleteCompletion("All set. Let me know if you'd like me to continue with tests.")).toBe(false);
    expect(detectIncompleteCompletion("Should I continue with the integration tests?")).toBe(false);
    expect(detectIncompleteCompletion("Would you like me to add error handling next?")).toBe(false);
  });

  it("does NOT fire on a mid-message 'we should' explanation (no first-person promise in the tail)", () => {
    expect(
      detectIncompleteCompletion(
        "I refactored the parser. Next we should consider caching, but that is optional and out of scope here."
      )
    ).toBe(false);
  });
});

describe("auto-continue wiring (unfinished natural stop)", () => {
  let root: string;
  const prev = process.env.AGENCY_AUTO_CONTINUE;

  beforeEach(() => {
    vi.clearAllMocks();
    root = mkdtempSync(join(tmpdir(), "agency-autocontinue-"));
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
    if (prev === undefined) delete process.env.AGENCY_AUTO_CONTINUE;
    else process.env.AGENCY_AUTO_CONTINUE = prev;
  });

  // A provider that always emits a no-tool-call "I'll continue" promise — it
  // never finishes on its own, so only the bound stops the loop.
  function alwaysPromising() {
    return {
      id: "openrouter" as const,
      complete: vi.fn(async () => "Started the work. I'll continue creating the remaining files."),
    };
  }

  it("flag ON: auto-continues up to MAX_AUTO_CONTINUE then stops (bounded, not maxLoops)", async () => {
    process.env.AGENCY_AUTO_CONTINUE = "1";
    const provider = alwaysPromising();
    mockedGetProvider.mockReturnValue(provider);

    await runChatTurnWithStream(
      { prompt: "build a multi-file app", projectRoot: root, skillsRoot: "/skills", sessionId: "s-on", maxLoops: 10, noVerify: true },
      { onRoute: () => {}, onDelta: () => {} }
    );

    // 1 initial completion + MAX_AUTO_CONTINUE auto-continues, then the bound trips
    // and the loop ends — well short of maxLoops=10.
    expect(provider.complete).toHaveBeenCalledTimes(1 + MAX_AUTO_CONTINUE);
  });

  it("flag OFF (legacy): a no-tool-call turn ends the loop immediately (byte-identical)", async () => {
    delete process.env.AGENCY_AUTO_CONTINUE; // legacy default = off
    const provider = alwaysPromising();
    mockedGetProvider.mockReturnValue(provider);

    await runChatTurnWithStream(
      { prompt: "build a multi-file app", projectRoot: root, skillsRoot: "/skills", sessionId: "s-off", maxLoops: 10, noVerify: true },
      { onRoute: () => {}, onDelta: () => {} }
    );

    expect(provider.complete).toHaveBeenCalledTimes(1);
  });

  it("flag ON: a genuinely-complete turn still ends after one completion (no needless continue)", async () => {
    process.env.AGENCY_AUTO_CONTINUE = "1";
    const provider = {
      id: "openrouter" as const,
      complete: vi.fn(async () => "All files created and the build passes. The implementation is complete."),
    };
    mockedGetProvider.mockReturnValue(provider);

    await runChatTurnWithStream(
      { prompt: "do a small fix", projectRoot: root, skillsRoot: "/skills", sessionId: "s-done", maxLoops: 10, noVerify: true },
      { onRoute: () => {}, onDelta: () => {} }
    );

    expect(provider.complete).toHaveBeenCalledTimes(1);
  });

  it("flag ON: non-stream runChatTurn auto-continues with the same bound", async () => {
    process.env.AGENCY_AUTO_CONTINUE = "1";
    const provider = alwaysPromising();
    mockedGetProvider.mockReturnValue(provider);

    await runChatTurn({
      prompt: "build a multi-file app",
      projectRoot: root,
      skillsRoot: "/skills",
      sessionId: "s-plain",
      maxLoops: 10,
      noVerify: true,
    });

    expect(provider.complete).toHaveBeenCalledTimes(1 + MAX_AUTO_CONTINUE);
  });
});
