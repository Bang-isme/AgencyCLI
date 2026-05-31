import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("execa", () => ({
  execa: vi.fn(),
}));

import { execa } from "execa";
import { ApprovalRequiredError } from "../approval/policy.js";
import {
  COMPACT_SCRIPT,
  compactContext,
  measureCodexMemoryBytes,
  parseCompactBytesSaved,
} from "../memory/compact.js";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "../../../..");
const FIXTURE = join(ROOT, "tests", "fixtures", "mock-skills");

const mockedExeca = vi.mocked(execa);

afterEach(() => {
  vi.clearAllMocks();
});

describe("parseCompactBytesSaved", () => {
  it("reads bytes_freed from JSON stdout", () => {
    expect(
      parseCompactBytesSaved(
        '{"status":"compacted","bytes_freed":4096,"sessions_archived":2}'
      )
    ).toBe(4096);
  });

  it("returns undefined for invalid stdout", () => {
    expect(parseCompactBytesSaved("not json")).toBeUndefined();
  });
});

describe("measureCodexMemoryBytes", () => {
  it("sums session and feedback markdown sizes", () => {
    const dir = join(tmpdir(), `agency-compact-${Date.now()}`);
    mkdirSync(join(dir, ".codex", "sessions"), { recursive: true });
    mkdirSync(join(dir, ".codex", "feedback"), { recursive: true });
    writeFileSync(join(dir, ".codex", "sessions", "a.md"), "aaaa");
    writeFileSync(join(dir, ".codex", "feedback", "b.md"), "bb");
    expect(measureCodexMemoryBytes(dir)).toBe(6);
  });
});

describe("compactContext", () => {
  it("throws ApprovalRequiredError when mutating without yes", async () => {
    await expect(compactContext(FIXTURE, ".")).rejects.toThrow(
      ApprovalRequiredError
    );
    await expect(compactContext(FIXTURE, ".")).rejects.toThrow(
      "compact requires approval (--yes or TUI confirm)"
    );
    expect(mockedExeca).not.toHaveBeenCalled();
  });

  it("runs dry-run with script args and parses bytes_freed", async () => {
    mockedExeca.mockResolvedValue({
      exitCode: 0,
      stdout: JSON.stringify({
        status: "compacted",
        sessions_archived: 1,
        feedback_archived: 0,
        decisions_kept: 3,
        bytes_freed: 1200,
      }),
      stderr: "",
    } as Awaited<ReturnType<typeof execa>>);

    const result = await compactContext(FIXTURE, "/proj", {
      dryRun: true,
      maxAgeDays: 90,
      keepLatest: 5,
    });

    expect(result.exitCode).toBe(0);
    expect(result.bytesSaved).toBe(1200);
    expect(mockedExeca).toHaveBeenCalledWith(
      "python",
      [
        join(FIXTURE, COMPACT_SCRIPT),
        "--project-root",
        "/proj",
        "--dry-run",
        "--max-age-days",
        "90",
        "--keep-latest",
        "5",
      ],
      { reject: false }
    );
  });

  it("runs mutating compaction when yes is true", async () => {
    mockedExeca.mockResolvedValue({
      exitCode: 0,
      stdout: '{"status":"compacted","bytes_freed":512}',
      stderr: "",
    } as Awaited<ReturnType<typeof execa>>);

    const result = await compactContext(FIXTURE, ".", { yes: true });

    expect(result.bytesSaved).toBe(512);
    expect(mockedExeca).toHaveBeenCalledWith(
      "python",
      [join(FIXTURE, COMPACT_SCRIPT), "--project-root", "."],
      { reject: false }
    );
  });
});
