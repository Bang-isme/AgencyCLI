import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
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
import { hasUnclosedToolCall } from "../skill/tool-harness.js";
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

/**
 * A provider whose single `write_file` call is split across two completions by
 * the output-token limit: completion 1 ends mid-`<content>` with finishReason
 * "length" (no closing tag); completion 2 emits the tail + the closing tags with
 * finishReason "stop". Reproduces the large-file-write churn bug. Exposes both
 * `streamComplete` (stream path) and `complete` (orchestrator path).
 */
function splitWriter(path: string) {
  let call = 0;
  const head = `Writing the file:\n<tool_call name="write_file">\n  <path>${path}</path>\n  <content>PART1`;
  const tail = `PART2</content>\n</tool_call>`;
  const gen = (opts: any): string => {
    call += 1;
    if (call === 1) {
      opts.onFinishReason?.("length");
      return head;
    }
    opts.onFinishReason?.("stop");
    return tail;
  };
  return {
    id: "openrouter" as const,
    streamComplete: vi.fn(async (_history: any, opts: any) => {
      opts.onDelta(gen(opts));
    }),
    complete: vi.fn(async (_history: any, opts: any) => gen(opts)),
  };
}

describe("hasUnclosedToolCall (pure)", () => {
  it("detects an opening tag with no matching close", () => {
    expect(hasUnclosedToolCall(`<tool_call name="write_file"><content>abc`)).toBe(true);
  });
  it("returns false for a complete tool call", () => {
    expect(hasUnclosedToolCall(`<tool_call name="x"><path>p</path></tool_call>`)).toBe(false);
  });
  it("returns false for plain prose", () => {
    expect(hasUnclosedToolCall("just some text, no tool calls")).toBe(false);
  });
  it("counts opens vs closes (still-open after one closed)", () => {
    expect(hasUnclosedToolCall(`<tool_call name="a"></tool_call><tool_call name="b">`)).toBe(true);
  });
});

describe("§8.10 tool-call reassembly across token-limit continuations", () => {
  let root: string;
  const prevFlag = process.env.AGENCY_TOOLCALL_REASSEMBLY;
  const prevAuto = process.env.AGENCY_AUTO_CONTINUE;

  beforeEach(() => {
    vi.clearAllMocks();
    root = mkdtempSync(join(tmpdir(), "agency-reassembly-"));
    clearRouteCache(root);
    mockedRoute.mockResolvedValue(route);
    mockedConfig.mockReturnValue({
      defaultProvider: "openrouter",
      providers: { openrouter: { apiKey: "key", model: "gpt-4o-mini" } },
    } as any);
    // Isolate from auto-continue so the OFF case ends deterministically.
    process.env.AGENCY_AUTO_CONTINUE = "0";
  });

  afterEach(() => {
    closeAllDbs();
    if (existsSync(root)) rmSync(root, { recursive: true, force: true });
    if (prevFlag === undefined) delete process.env.AGENCY_TOOLCALL_REASSEMBLY;
    else process.env.AGENCY_TOOLCALL_REASSEMBLY = prevFlag;
    if (prevAuto === undefined) delete process.env.AGENCY_AUTO_CONTINUE;
    else process.env.AGENCY_AUTO_CONTINUE = prevAuto;
  });

  it("flag ON (stream): the split write executes exactly once with the joined content", async () => {
    process.env.AGENCY_TOOLCALL_REASSEMBLY = "1";
    mockedGetProvider.mockReturnValue(splitWriter("out.txt") as any);

    await runChatTurnWithStream(
      { prompt: "write a big file", projectRoot: root, skillsRoot: "/skills", sessionId: "s-on", maxLoops: 2, noVerify: true },
      { onRoute: () => {}, onDelta: () => {} }
    );

    const target = join(root, "out.txt");
    expect(existsSync(target)).toBe(true);
    expect(readFileSync(target, "utf8")).toBe("PART1PART2");
  });

  it("flag OFF (opt-out stream): the split write is dropped — file never written (legacy path preserved)", async () => {
    process.env.AGENCY_TOOLCALL_REASSEMBLY = "0"; // explicit opt-out (now on by default)
    mockedGetProvider.mockReturnValue(splitWriter("out.txt") as any);

    await runChatTurnWithStream(
      { prompt: "write a big file", projectRoot: root, skillsRoot: "/skills", sessionId: "s-off", maxLoops: 2, noVerify: true },
      { onRoute: () => {}, onDelta: () => {} }
    );

    expect(existsSync(join(root, "out.txt"))).toBe(false);
  });

  it("flag ON (non-stream runChatTurn): same reassembly on the orchestrator path", async () => {
    process.env.AGENCY_TOOLCALL_REASSEMBLY = "1";
    mockedGetProvider.mockReturnValue(splitWriter("doc.md") as any);

    await runChatTurn({
      prompt: "write a big doc",
      projectRoot: root,
      skillsRoot: "/skills",
      sessionId: "s-plain",
      maxLoops: 2,
      noVerify: true,
    });

    const target = join(root, "doc.md");
    expect(existsSync(target)).toBe(true);
    expect(readFileSync(target, "utf8")).toBe("PART1PART2");
  });
});
