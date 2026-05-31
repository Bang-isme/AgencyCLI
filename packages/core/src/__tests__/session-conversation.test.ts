import { describe, expect, it, vi, afterEach } from "vitest";
import { existsSync, readFileSync, appendFileSync, writeFileSync } from "node:fs";
import { SessionConversationManager } from "../chat/session-conversation.js";

vi.mock("node:fs", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs")>();
  return {
    ...original,
    existsSync: vi.fn(),
    readFileSync: vi.fn(),
    appendFileSync: vi.fn(),
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn(),
  };
});

const mockedExistsSync = vi.mocked(existsSync);
const mockedReadFileSync = vi.mocked(readFileSync);
const mockedAppendFileSync = vi.mocked(appendFileSync);
const mockedWriteFileSync = vi.mocked(writeFileSync);

afterEach(() => {
  vi.clearAllMocks();
});

describe("SessionConversationManager", () => {
  it("appends and loads message logs in append-only JSONL format", () => {
    const root = "/fake/project";
    const mgr = new SessionConversationManager(root, "session-123");

    mgr.appendMessage({ role: "user", content: "hello" });
    expect(mockedAppendFileSync).toHaveBeenCalled();
    const [path, line] = mockedAppendFileSync.mock.calls[0] as [string, string];
    expect(path).toContain("session-123.jsonl");
    expect(JSON.parse(line)).toEqual({ role: "user", content: "hello" });

    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockReturnValue(
      JSON.stringify({ role: "system", content: "sys" }) +
        "\n" +
        JSON.stringify({ role: "user", content: "hello" }) +
        "\n"
    );

    const history = mgr.loadHistory();
    expect(history.length).toBe(2);
    expect(history[0]?.role).toBe("system");
    expect(history[1]?.content).toBe("hello");
  });

  it("summarizes conversation when exceeding threshold", async () => {
    const root = "/fake/project";
    const mgr = new SessionConversationManager(root, "session-123");

    const history = [
      { role: "system", content: "original instruction" },
      { role: "user", content: "some middle turn 1" },
      { role: "assistant", content: "some middle turn 2" },
      { role: "user", content: "last turn 4" },
      { role: "assistant", content: "last turn 3" },
      { role: "user", content: "last turn 2" },
      { role: "assistant", content: "last turn 1" },
    ] as any[];

    // threshold = contextWindowLimit * 0.7.
    // Let's set contextWindowLimit = 50 tokens (so threshold is 35).
    // The history contains about 100 characters, which is ~25 tokens + overhead.
    // Let's set contextWindowLimit = 20 tokens to force summarization.
    const mockProvider = {
      complete: vi.fn().mockResolvedValue({ text: "Mock Summary" }),
    };

    const res = await mgr.summarizeHistory(history, mockProvider, 20);

    expect(res).toBeDefined();
    expect(res.length).toBe(6); // system turn + summary turn + 4 last turns
    expect(res[0]?.content).toBe("original instruction");
    expect(res[1]?.content).toContain("Mock Summary");
    expect(res[2]?.content).toBe("last turn 4");
    expect(res[5]?.content).toBe("last turn 1");

    expect(mockedWriteFileSync).toHaveBeenCalled();
  });

  it("uses character truncation fallback if provider fails", async () => {
    const root = "/fake/project";
    const mgr = new SessionConversationManager(root, "session-123");

    const history = [
      { role: "system", content: "original instruction" },
      { role: "user", content: "some middle turn 1" },
      { role: "assistant", content: "some middle turn 2" },
      { role: "user", content: "last turn 4" },
      { role: "assistant", content: "last turn 3" },
      { role: "user", content: "last turn 2" },
      { role: "assistant", content: "last turn 1" },
    ] as any[];

    // Trigger fallback by not passing a provider
    const res = await mgr.summarizeHistory(history, null, 20);

    expect(res.length).toBe(6);
    expect(res[1]?.content).toContain("[SYSTEM HISTORICAL CONVERSATION SUMMARY]: [Dialogue history compressed: truncated 2 middle turns to save memory context]");
  });
});
