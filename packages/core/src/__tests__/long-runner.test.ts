import { describe, expect, it, vi, afterEach, beforeEach } from "vitest";
import { existsSync, readFileSync, appendFileSync, writeFileSync } from "node:fs";
import { LongRunnerManager, RunnerState } from "../task/long-runner-manager.js";

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
  vi.useRealTimers();
});

describe("LongRunnerManager", () => {
  let root: string;

  beforeEach(() => {
    root = "/fake/project";
    mockedExistsSync.mockReturnValue(true);
  });

  it("registers and saves runner states cleanly", () => {
    const mgr = new LongRunnerManager(root);

    mgr.registerRunner("runner-1", "task-123");
    expect(mockedAppendFileSync).toHaveBeenCalled();

    const [path, line] = mockedAppendFileSync.mock.calls[0] as [string, string];
    expect(path).toContain("runners.jsonl");

    const saved = JSON.parse(line) as RunnerState;
    expect(saved.id).toBe("runner-1");
    expect(saved.taskId).toBe("task-123");
    expect(saved.status).toBe("running");

    mgr.stopAll();
  });

  it("detects stalled runners correctly and triggers failover callback", async () => {
    vi.useFakeTimers();

    const mgr = new LongRunnerManager(root);

    // Mock load history with a running runner that hasn't posted a heartbeat in 20 seconds
    const oldTime = Date.now() - 20000;
    mockedReadFileSync.mockReturnValue(
      JSON.stringify({
        id: "runner-stalled",
        taskId: "task-1",
        status: "running",
        lastHeartbeat: oldTime,
      } as RunnerState) + "\n"
    );

    const onStalled = vi.fn().mockResolvedValue(undefined);

    await mgr.checkStalledRunners(onStalled);

    expect(onStalled).toHaveBeenCalled();
    const calledWith = onStalled.mock.calls[0][0] as RunnerState;
    expect(calledWith.id).toBe("runner-stalled");
    expect(calledWith.status).toBe("stalled");

    mgr.stopAll();
  });
});
