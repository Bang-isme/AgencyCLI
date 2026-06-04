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
import { runChatTurnWithStream } from "../chat/stream.js";
import { EventBus } from "../events/event-bus.js";

const mockedRoute = vi.mocked(routeUserPrompt);
const mockedConfig = vi.mocked(providers.loadAgencyConfig);
const mockedGetProvider = vi.mocked(providers.getProvider);
const mockedUpdateModelOverride = vi.mocked(providers.updateModelOverride);

const route: RouteResult = {
  intent: "debug",
  suggested_agent: null,
  workflow: "fix",
  skills: [],
  provider: "openrouter",
  warnings: [],
};

const input = {
  prompt: "fix test",
  projectRoot: "/proj",
  skillsRoot: "/skills",
};

beforeEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  clearRouteCache(input.projectRoot);
  mockedRoute.mockResolvedValue(route);
});

describe("runChatTurnWithStream", () => {
  it("emits route then streamed deltas", async () => {
    const deltas: string[] = [];
    let routeEvents = 0;

    mockedConfig.mockReturnValue({
      defaultProvider: "openrouter",
      providers: { openrouter: { apiKey: "key" } },
    });
    mockedGetProvider.mockReturnValue({
      id: "openrouter",
      complete: vi.fn(),
      streamComplete: vi.fn(async (_msgs, opts) => {
        opts.onDelta("Hel");
        opts.onDelta("lo");
        return "Hello";
      }),
    });

    const result = await runChatTurnWithStream(input, {
      onRoute: () => {
        routeEvents += 1;
      },
      onDelta: (d) => deltas.push(d),
    });

    expect(routeEvents).toBe(1);
    expect(deltas).toEqual(["Hel", "lo"]);
    expect(result.routeOnly).toBe(false);
    expect(result.assistantText).toContain("Hello");
  });

  it("publishes tool:started / tool:finished on the EventBus (Phase A event-first)", async () => {
    mockedConfig.mockReturnValue({
      defaultProvider: "openrouter",
      providers: { openrouter: { apiKey: "key" } },
    });
    // Turn 1 emits a tool call; turn 2 ends the loop with plain prose.
    let call = 0;
    mockedGetProvider.mockReturnValue({
      id: "openrouter",
      complete: vi.fn(),
      streamComplete: vi.fn(async (_msgs, opts) => {
        call += 1;
        if (call === 1) {
          const xml = `<tool_call name="find_files">\n  <pattern>*.nonexistent-xyz</pattern>\n</tool_call>`;
          opts.onDelta(xml);
          return xml;
        }
        opts.onDelta("All done.");
        return "All done.";
      }),
    });

    const started: any[] = [];
    const done: any[] = [];
    const bus = EventBus.getInstance();
    // Subscribers receive the ReplayEvent; the structured payload is event.payload
    // (a JSON string), per the App's own consumption pattern.
    const parse = (event: any) =>
      typeof event?.payload === "string" ? JSON.parse(event.payload) : event?.payload ?? event;
    const onStart = (e: any) => started.push(parse(e));
    const onDone = (e: any) => done.push(parse(e));
    bus.subscribe("tool:started", onStart);
    bus.subscribe("tool:finished", onDone);
    bus.subscribe("tool:failed", onDone);
    try {
      await runChatTurnWithStream(input, { onRoute: () => {}, onDelta: () => {} });
      // Delivery is async (scheduleDrain → setImmediate); flush before asserting.
      await new Promise((r) => setTimeout(r, 30));
    } finally {
      bus.unsubscribe("tool:started", onStart);
      bus.unsubscribe("tool:finished", onDone);
      bus.unsubscribe("tool:failed", onDone);
    }

    const startedFind = started.find((e) => e.name === "find_files");
    expect(startedFind).toBeTruthy();
    expect(startedFind.category).toBe("search");
    expect(typeof startedFind.seq).toBe("number");
    // A completion event (finished or failed) fires for the same tool.
    expect(done.some((e) => e.name === "find_files")).toBe(true);
  });

  it("falls back to complete with single delta when stream unsupported", async () => {
    const deltas: string[] = [];
    mockedConfig.mockReturnValue({
      defaultProvider: "openrouter",
      providers: { openrouter: { apiKey: "key" } },
    });
    mockedGetProvider.mockReturnValue({
      id: "openrouter",
      complete: vi.fn().mockResolvedValue("Done."),
    });

    await runChatTurnWithStream(input, {
      onRoute: () => {},
      onDelta: (d) => deltas.push(d),
    });

    expect(deltas).toEqual(["Done."]);
  });

  it("automatically recovers from context limit error with decay and retry", async () => {
    mockedConfig.mockReturnValue({
      defaultProvider: "openrouter",
      providers: { openrouter: { apiKey: "key", model: "gpt-4o-mini" } },
    });

    let calls = 0;
    const mockComplete = vi.fn(async () => {
      calls++;
      if (calls === 1) {
        throw new Error("maximum context length is 128000 tokens. However, you requested 130000 tokens.");
      }
      return "Success after healing";
    });

    mockedGetProvider.mockReturnValue({
      id: "openrouter",
      complete: mockComplete,
    });

    const result = await runChatTurnWithStream(input, {
      onRoute: () => {},
      onDelta: () => {},
    });

    expect(calls).toBe(2);
    // §8.1: honour the provider's stated real limit (128000) and trim the body
    // to fit it, instead of ratcheting the window down 20% on every retry (the
    // old 102400 behaviour drove minimax-m2.7 from 196608 to 16887 on disk).
    expect(mockedUpdateModelOverride).toHaveBeenCalledWith("gpt-4o-mini", {
      contextWindow: 128000,
    });
    expect(result.assistantText).toBe("Success after healing");
  });

  it("bubbles up error if context window is at the safety floor and still errors", async () => {
    mockedConfig.mockReturnValue({
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

    await expect(
      runChatTurnWithStream(input, {
        onRoute: () => {},
        onDelta: () => {},
      })
    ).rejects.toThrow("context_length_exceeded");

    // Should not have updated the override since it was already at the floor
    expect(mockedUpdateModelOverride).not.toHaveBeenCalled();
  });
});
