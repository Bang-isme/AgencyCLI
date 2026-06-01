import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("@agency/providers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@agency/providers")>();
  return {
    ...actual,
    loadAgencyConfig: vi.fn(),
    getProvider: vi.fn(),
    updateModelOverride: vi.fn(),
  };
});

// `baseRoute` (returned by the stubbed `resolveRoute`) and `compactSpy` are
// declared via `vi.hoisted` so they are available inside the (hoisted) mock
// factory below — referencing a plain top-level `const` there throws.
const { baseRoute, compactSpy } = vi.hoisted(() => ({
  baseRoute: {
    intent: "debug",
    suggested_agent: "debugger",
    workflow: "fix",
    skills: [] as string[],
    provider: "anthropic" as const,
    warnings: [] as string[],
  },
  compactSpy: vi.fn((messages: any) => ({ messages, compacted: false, summarizedTurns: 0 })),
}));

// Mock the shared turn-setup helpers with lightweight STUBS — and deliberately
// WITHOUT `importOriginal()`. `chat/turn-helpers.ts` sits on a real runtime
// import cycle (turn-helpers → prompt → tool-harness → agents/orchestrator →
// stream → orchestrator). If the factory called `importOriginal()` it would pull
// the real `orchestrator` back in through that cycle, so the orchestrator would
// bind the *real* `compactTurnHistory` instead of the spy below — and the spy
// would never register a call. Providing self-contained stubs avoids loading the
// real module during mock setup, so the orchestrator binds to this spy. We only
// need to count WHERE `compactTurnHistory` is invoked (the wiring under test);
// the other helpers are stubbed just enough to let the turn reach its loop.
vi.mock("../chat/turn-helpers.js", () => ({
  resolveSessionId: (explicit?: string) => explicit ?? "sess-test",
  resolveRoute: vi.fn(async () => ({ route: baseRoute, fromCache: false })),
  providerHasKey: () => true,
  repackContextAndSystemPrompt: () => "system",
  recordTurnTokenCost: () => {},
  compactTurnHistory: compactSpy,
  // The main-turn tool loop now narrates each tool via describeToolActivity →
  // emitThought (§8.10-A); the stubbed turn-helpers must provide it or the
  // unconditional call site throws (the tool path here writes t.txt, no agentId).
  describeToolActivity: () => ({ source: "worker", phase: "editing", severity: "info", confidence: "high", message: "stub" }),
}));

import * as providers from "@agency/providers";
import { clearRouteCache } from "../context/session-cache.js";
import { runChatTurn } from "../chat/orchestrator.js";
import { runChatTurnWithStream } from "../chat/stream.js";
import { closeAllDbs } from "@agency/memory";

const mockedConfig = vi.mocked(providers.loadAgencyConfig);
const mockedGetProvider = vi.mocked(providers.getProvider);

// A provider that emits one tool call (iteration 1) then a final answer
// (iteration 2) → exactly two outer-loop iterations.
function twoIterationProvider() {
  let calls = 0;
  return {
    id: "anthropic" as const,
    complete: vi.fn(async () => {
      calls++;
      if (calls === 1) {
        return 'Writing:\n<tool_call name="write_file">\n  <path>t.txt</path>\n  <content>hi</content>\n</tool_call>';
      }
      return "Done.";
    }),
  };
}

describe("in-loop context compaction (§2.3 cont'd 21)", () => {
  let root: string;
  const prev = process.env.AGENCY_CONTEXT_COMPACTION;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "agency-inloop-"));
    clearRouteCache(root);
    mockedConfig.mockReturnValue({ defaultProvider: "anthropic", providers: { anthropic: { apiKey: "sk-test" } } });
    compactSpy.mockClear();
  });

  afterEach(() => {
    closeAllDbs();
    if (existsSync(root)) rmSync(root, { recursive: true, force: true });
    if (prev === undefined) delete process.env.AGENCY_CONTEXT_COMPACTION;
    else process.env.AGENCY_CONTEXT_COMPACTION = prev;
  });

  it("flag ON: runChatTurnWithStream compacts before the loop AND at each iteration (1 + 2 = 3)", async () => {
    process.env.AGENCY_CONTEXT_COMPACTION = "1";
    mockedGetProvider.mockReturnValue(twoIterationProvider());

    await runChatTurnWithStream(
      { prompt: "write t.txt", projectRoot: root, skillsRoot: "/skills", sessionId: "s-stream" },
      { onRoute: () => {}, onDelta: () => {} }
    );

    // pre-loop (1) + top-of-iteration ×2 = 3
    expect(compactSpy).toHaveBeenCalledTimes(3);
  });

  it("flag OFF (legacy): compaction is never invoked (byte-identical)", async () => {
    delete process.env.AGENCY_CONTEXT_COMPACTION; // legacy default = off
    mockedGetProvider.mockReturnValue(twoIterationProvider());

    await runChatTurnWithStream(
      { prompt: "write t.txt", projectRoot: root, skillsRoot: "/skills", sessionId: "s-off" },
      { onRoute: () => {}, onDelta: () => {} }
    );

    expect(compactSpy).not.toHaveBeenCalled();
  });

  it("flag ON: runChatTurn (non-stream) also compacts per iteration (1 + 2 = 3)", async () => {
    process.env.AGENCY_CONTEXT_COMPACTION = "1";
    mockedGetProvider.mockReturnValue(twoIterationProvider());

    await runChatTurn({ prompt: "write t.txt", projectRoot: root, skillsRoot: "/skills", sessionId: "s-plain" });

    expect(compactSpy).toHaveBeenCalledTimes(3);
  });
});
