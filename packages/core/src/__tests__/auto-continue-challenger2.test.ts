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
import { MAX_AUTO_CONTINUE } from "../chat/turn-helpers.js";
import { closeAllDbs } from "@agency/memory";
import { EventBus } from "../events/event-bus.js";

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

describe("Auto-Continuation Loop and Retry Challenger 2 Integration Tests", () => {
  let root: string;
  let prevAutoContinue: string | undefined;
  let setTimeoutSpy: any;
  let setImmediateSpy: any;
  const warnings: any[] = [];
  
  const warningCallback = (event: any) => {
    warnings.push(event);
  };

  beforeEach(() => {
    vi.clearAllMocks();
    root = mkdtempSync(join(tmpdir(), "agency-challenger2-"));
    clearRouteCache(root);
    mockedRoute.mockResolvedValue(route);
    mockedConfig.mockReturnValue({
      defaultProvider: "openrouter",
      providers: { openrouter: { apiKey: "key", model: "gpt-4o-mini" } },
    });

    prevAutoContinue = process.env.AGENCY_AUTO_CONTINUE;

    // Spy/mock setTimeout to run callbacks synchronously so retries are instantaneous
    setTimeoutSpy = vi.spyOn(global, "setTimeout").mockImplementation((fn: any) => {
      fn();
      return {} as any;
    });

    // Spy/mock setImmediate to process EventBus events synchronously
    setImmediateSpy = vi.spyOn(global, "setImmediate").mockImplementation((fn: any) => {
      fn();
      return {} as any;
    });

    warnings.length = 0;
    EventBus.getInstance().subscribe("system:warning", warningCallback);
  });

  afterEach(() => {
    closeAllDbs();
    EventBus.getInstance().unsubscribe("system:warning", warningCallback);
    if (existsSync(root)) {
      rmSync(root, { recursive: true, force: true });
    }
    if (prevAutoContinue === undefined) {
      delete process.env.AGENCY_AUTO_CONTINUE;
    } else {
      process.env.AGENCY_AUTO_CONTINUE = prevAutoContinue;
    }
    setTimeoutSpy.mockRestore();
    setImmediateSpy.mockRestore();
  });

  it("non-streaming runChatTurn: retries on 429, 503, 504 and transient errors, then succeeds", async () => {
    process.env.AGENCY_AUTO_CONTINUE = "1";
    let attempts = 0;
    const provider = {
      id: "openrouter" as const,
      complete: vi.fn(async () => {
        attempts++;
        if (attempts === 1) {
          const err = new Error("Mock 429 Rate Limit Exceeded") as any;
          err.status = 429;
          throw err;
        }
        if (attempts === 2) {
          const err = new Error("Mock 503 Service Unavailable") as any;
          err.status = 503;
          throw err;
        }
        if (attempts === 3) {
          const err = new Error("Mock 504 Gateway Timeout") as any;
          err.status = 504;
          throw err;
        }
        return "Success on attempt 4";
      }),
    };
    mockedGetProvider.mockReturnValue(provider);

    const result = await runChatTurn({
      prompt: "test transient errors",
      projectRoot: root,
      skillsRoot: "/skills",
      sessionId: "s-retry-nonstream",
      maxLoops: 5,
      noVerify: true,
    });

    expect(attempts).toBe(4);
    expect(result.assistantText).toBe("Success on attempt 4");
    // Should have published warnings to EventBus
    expect(warnings.length).toBeGreaterThanOrEqual(3);
    expect(warnings[0].payload).toContain("failed with transient error");
  });

  it("streaming runChatTurnWithStream: retries on transient errors, then succeeds", async () => {
    process.env.AGENCY_AUTO_CONTINUE = "1";
    let attempts = 0;
    const provider = {
      id: "openrouter" as const,
      complete: vi.fn(async () => {
        attempts++;
        if (attempts === 1) {
          const err = new Error("Mock 429 Rate Limit Exceeded") as any;
          err.status = 429;
          throw err;
        }
        return "Success on attempt 2";
      }),
    };
    mockedGetProvider.mockReturnValue(provider);

    const result = await runChatTurnWithStream(
      {
        prompt: "test transient errors stream",
        projectRoot: root,
        skillsRoot: "/skills",
        sessionId: "s-retry-stream",
        maxLoops: 5,
        noVerify: true,
      },
      { onRoute: () => {}, onDelta: () => {} }
    );

    expect(attempts).toBe(2);
    expect(result.assistantText).toBe("Success on attempt 2");
    expect(warnings.length).toBe(1);
    expect(warnings[0].payload).toContain("failed with transient error");
  });

  it("throws after exceeding max transient retry attempts (maxTransientAttempts = 3)", async () => {
    process.env.AGENCY_AUTO_CONTINUE = "1";
    let attempts = 0;
    const provider = {
      id: "openrouter" as const,
      complete: vi.fn(async () => {
        attempts++;
        const err = new Error("Mock 503 Service Unavailable") as any;
        err.status = 503;
        throw err;
      }),
    };
    mockedGetProvider.mockReturnValue(provider);

    await expect(
      runChatTurn({
        prompt: "test transient error limit",
        projectRoot: root,
        skillsRoot: "/skills",
        sessionId: "s-retry-limit",
        maxLoops: 5,
        noVerify: true,
      })
    ).rejects.toThrow("Mock 503 Service Unavailable");

    // 1 initial attempt + 3 retries = 4 total attempts
    expect(attempts).toBe(4);
  });

  it("triggers auto-continuation on length-truncated responses and resumes cleanly", async () => {
    process.env.AGENCY_AUTO_CONTINUE = "1";
    let calls = 0;
    const provider = {
      id: "openrouter" as const,
      complete: vi.fn(async (history, opts) => {
        calls++;
        if (calls === 1) {
          opts.onFinishReason?.("length");
          return "This is a response that got cut off mid-";
        }
        return "sentence. Here is the rest.";
      }),
    };
    mockedGetProvider.mockReturnValue(provider);

    const result = await runChatTurnWithStream(
      {
        prompt: "length truncation test",
        projectRoot: root,
        skillsRoot: "/skills",
        sessionId: "s-length-truncation",
        maxLoops: 5,
        noVerify: true,
      },
      { onRoute: () => {}, onDelta: () => {} }
    );

    expect(calls).toBe(2);
    expect(result.assistantText).toBe("This is a response that got cut off mid-sentence. Here is the rest.");
  });

  it("non-streaming runChatTurn: triggers auto-continuation on length-truncated responses and resumes cleanly", async () => {
    process.env.AGENCY_AUTO_CONTINUE = "1";
    let calls = 0;
    const provider = {
      id: "openrouter" as const,
      complete: vi.fn(async (history, opts) => {
        calls++;
        if (calls === 1) {
          opts.onFinishReason?.("length");
          return "This is a response that got cut off mid-";
        }
        return "sentence. Here is the rest.";
      }),
    };
    mockedGetProvider.mockReturnValue(provider);

    const result = await runChatTurn({
      prompt: "length truncation test non-stream",
      projectRoot: root,
      skillsRoot: "/skills",
      sessionId: "s-length-truncation-nonstream",
      maxLoops: 5,
      noVerify: true,
    });

    expect(calls).toBe(2);
    expect(result.assistantText).toBe("This is a response that got cut off mid-sentence. Here is the rest.");
  });

  it("stops and outputs warning notice when auto-continue count exceeds MAX_AUTO_CONTINUE", async () => {
    process.env.AGENCY_AUTO_CONTINUE = "1";
    const provider = {
      id: "openrouter" as const,
      complete: vi.fn(async () => "I will implement the rest of the code next."),
    };
    mockedGetProvider.mockReturnValue(provider);

    const result = await runChatTurnWithStream(
      {
        prompt: "auto-continue limit test",
        projectRoot: root,
        skillsRoot: "/skills",
        sessionId: "s-autocontinue-limit",
        maxLoops: 10,
        noVerify: true,
      },
      { onRoute: () => {}, onDelta: () => {} }
    );

    // 1 initial completion + MAX_AUTO_CONTINUE (3) auto-continues = 4 completions
    expect(provider.complete).toHaveBeenCalledTimes(1 + MAX_AUTO_CONTINUE);
    expect(result.assistantText).toContain("Turn paused — the model stopped 3 times in a row without calling tools");
    expect(warnings.some(w => w.payload && w.payload.includes("Turn paused after 3 resume attempt(s)"))).toBe(true);
  });
});
