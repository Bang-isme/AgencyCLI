import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("execa", () => ({
  execa: vi.fn(),
}));

import { execa } from "execa";
import {
  ApprovalRequiredError,
  runMemoryScript,
} from "../memory/bridge.js";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "../../../..");
const FIXTURE = join(ROOT, "tests", "fixtures", "mock-skills");

const mockedExeca = vi.mocked(execa);

afterEach(() => {
  vi.clearAllMocks();
});

describe("runMemoryScript", () => {
  it("throws ApprovalRequiredError when build runs without yes", async () => {
    await expect(
      runMemoryScript(FIXTURE, "build", ["--project-root", "."])
    ).rejects.toThrow(ApprovalRequiredError);
    await expect(
      runMemoryScript(FIXTURE, "build", ["--project-root", "."])
    ).rejects.toThrow("memory build requires approval (--yes or TUI confirm)");
    expect(mockedExeca).not.toHaveBeenCalled();
  });

  it("runs build when yes is true", async () => {
    mockedExeca.mockResolvedValue({
      exitCode: 0,
      stdout: '{"ok":true}',
      stderr: "",
    } as Awaited<ReturnType<typeof execa>>);

    const result = await runMemoryScript(
      FIXTURE,
      "build",
      ["--project-root", "."],
      { yes: true }
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('{"ok":true}');
    expect(mockedExeca).toHaveBeenCalledWith(
      "python",
      [
        join(
          FIXTURE,
          "codex-project-memory/scripts/build_knowledge_index.py"
        ),
        "--project-root",
        ".",
      ],
      { cwd: undefined, reject: false }
    );
  });

  it("runs status without yes", async () => {
    mockedExeca.mockResolvedValue({
      exitCode: 0,
      stdout: '{"status":"pass"}',
      stderr: "",
    } as Awaited<ReturnType<typeof execa>>);

    const result = await runMemoryScript(FIXTURE, "status", [
      "--project-root",
      ".",
      "--format",
      "json",
    ]);

    expect(result.exitCode).toBe(0);
    expect(mockedExeca).toHaveBeenCalledWith(
      "python",
      [
        join(FIXTURE, "codex-project-memory/scripts/memory_status.py"),
        "--project-root",
        ".",
        "--format",
        "json",
      ],
      { cwd: undefined, reject: false }
    );
  });

  it("runs genome without yes", async () => {
    mockedExeca.mockResolvedValue({
      exitCode: 0,
      stdout: '{"genome":"ok"}',
      stderr: "",
    } as Awaited<ReturnType<typeof execa>>);

    const result = await runMemoryScript(FIXTURE, "genome", [
      "--project-root",
      ".",
      "--depth",
      "auto",
      "--format",
      "json",
    ]);

    expect(result.exitCode).toBe(0);
    expect(mockedExeca).toHaveBeenCalledWith(
      "python",
      [
        join(FIXTURE, "codex-project-memory/scripts/generate_genome.py"),
        "--project-root",
        ".",
        "--depth",
        "auto",
        "--format",
        "json",
      ],
      { cwd: undefined, reject: false }
    );
  });

  it("falls back to python3 if python binary is missing (ENOENT)", async () => {
    const err = new Error("Command 'python' not found");
    (err as any).code = "ENOENT";
    mockedExeca.mockRejectedValueOnce(err);
    mockedExeca.mockResolvedValueOnce({
      exitCode: 0,
      stdout: '{"fallback":"python3"}',
      stderr: "",
    } as any);

    const result = await runMemoryScript(FIXTURE, "status", [
      "--project-root",
      ".",
    ]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('{"fallback":"python3"}');
    
    expect(mockedExeca).toHaveBeenNthCalledWith(
      1,
      "python",
      expect.any(Array),
      expect.any(Object)
    );
    expect(mockedExeca).toHaveBeenNthCalledWith(
      2,
      "python3",
      expect.any(Array),
      expect.any(Object)
    );
  });
});
