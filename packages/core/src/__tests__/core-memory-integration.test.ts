import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
import { runChatTurnWithStream } from "../chat/stream.js";
import { getDb, closeAllDbs, EpisodicStore } from "@agency/memory";
import { safeAddEpisode } from "../chat/memory-integration.js";

const mockedRouteUserPrompt = vi.mocked(routeUserPrompt);
const mockedLoadAgencyConfig = vi.mocked(providers.loadAgencyConfig);
const mockedGetProvider = vi.mocked(providers.getProvider);

const baseRoute = {
  intent: "debug",
  suggested_agent: "debugger",
  workflow: "fix",
  skills: [],
  provider: "anthropic" as const,
  warnings: [],
};

describe("Phase 2: Core and Memory Integration", () => {
  let tempProjectRoot: string;

  beforeEach(() => {
    tempProjectRoot = mkdtempSync(join(tmpdir(), "agency-core-mem-"));
    clearRouteCache(tempProjectRoot);
    mockedRouteUserPrompt.mockResolvedValue(baseRoute);
  });

  afterEach(() => {
    closeAllDbs();
    if (existsSync(tempProjectRoot)) {
      rmSync(tempProjectRoot, { recursive: true, force: true });
    }
  });

  it("should retrieve memory and pass to prompt, then save turn outcomes in runChatTurn", async () => {
    const sessionId = "sess-core-1";

    // 1. Ingest some pre-existing memory for FTS to find
    safeAddEpisode(
      tempProjectRoot,
      "sess-older",
      "Configure project build environment",
      0,
      "user_input",
      "Need to build the packages via tsc"
    );

    // 2. Mock provider complete to check that the history is passed in system prompt
    let systemPromptContent = "";
    const complete = vi.fn().mockImplementation((messages) => {
      const systemMsg = messages.find((m: any) => m.role === "system");
      systemPromptContent = systemMsg ? systemMsg.content : "";
      return "Assistant reply: I see you want to configure build.";
    });

    mockedLoadAgencyConfig.mockReturnValue({
      defaultProvider: "anthropic",
      providers: { anthropic: { apiKey: "sk-test" } },
    });
    mockedGetProvider.mockReturnValue({
      id: "anthropic",
      complete,
    });

    // 3. Execute runChatTurn
    const result = await runChatTurn({
      prompt: "Configure tsc compile build",
      projectRoot: tempProjectRoot,
      skillsRoot: "/skills",
      sessionId,
    });

    // Check system prompt has historical memories section
    expect(systemPromptContent).toContain("SYSTEM HISTORICAL MEMORIES");
    expect(systemPromptContent).toContain("Configure project build environment");
    expect(systemPromptContent).toContain("Need to build the packages via tsc");

    // Check that memory has been saved for this turn
    const db = getDb(tempProjectRoot);
    const store = new EpisodicStore(db);
    const episodes = store.getEpisodes(sessionId);

    // Should have user input and assistant reply episodes
    expect(episodes.length).toBe(2);
    expect(episodes.find((e) => e.action_signature === "user_input")?.content).toContain("Configure tsc compile build");
    expect(episodes.find((e) => e.action_signature === "assistant_reply")?.content).toContain("Assistant reply: I see you want to configure build.");
  });

  it("should integrate memory in runChatTurnWithStream and record tool calls as episodes", async () => {
    const sessionId = "sess-core-2";

    // 1. Mock provider to output a write_file tool call first, and then a final text reply
    let completeCalls = 0;
    const complete = vi.fn().mockImplementation(async () => {
      completeCalls++;
      if (completeCalls === 1) {
        return 'Let\'s write the file:\n<tool_call name="write_file">\n  <path>test.txt</path>\n  <content>hello sandbox</content>\n</tool_call>';
      }
      return "File has been written successfully.";
    });

    mockedLoadAgencyConfig.mockReturnValue({
      defaultProvider: "anthropic",
      providers: { anthropic: { apiKey: "sk-test" } },
    });
    mockedGetProvider.mockReturnValue({
      id: "anthropic",
      complete,
    });

    // 2. Execute runChatTurnWithStream
    await runChatTurnWithStream(
      {
        prompt: "write test.txt with hello sandbox",
        projectRoot: tempProjectRoot,
        skillsRoot: "/skills",
        sessionId,
      },
      {
        onRoute: () => {},
        onDelta: () => {},
      }
    );

    // Verify SQLite episodes: user_input, tool_call:write_file, assistant_reply
    const db = getDb(tempProjectRoot);
    const store = new EpisodicStore(db);
    const episodes = store.getEpisodes(sessionId);

    expect(episodes.length).toBe(3);
    expect(episodes[0]!.action_signature).toBe("user_input");
    expect(episodes[1]!.action_signature).toBe("tool_call:write_file");
    expect(episodes[1]!.content).toContain("test.txt");
    expect(episodes[1]!.content).toContain("hello sandbox");
    expect(episodes[2]!.action_signature).toBe("assistant_reply");
    expect(episodes[2]!.content).toContain("File has been written successfully.");
  });
});
