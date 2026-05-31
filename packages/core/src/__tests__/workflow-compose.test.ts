import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("execa", () => ({
  execa: vi.fn(),
}));

// Avoid the python-interpreter probe (an extra execa call) so the mock-call
// indices below refer to the actual workflow-step invocations.
vi.mock("@agency/skills-bridge", () => ({
  resolvePythonBin: vi.fn().mockResolvedValue("python"),
}));

import { execa } from "execa";
import {
  ApprovalRequiredError,
  resolveWorkflowSteps,
  runWorkflow,
  RUNTIME_HOOK_TIMEOUT,
  WORKFLOWS,
} from "../workflow/compose.js";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "../../../..");
const FIXTURE = join(ROOT, "tests", "fixtures", "mock-skills");

const mockedExeca = vi.mocked(execa);

afterEach(() => {
  vi.clearAllMocks();
});

describe("WORKFLOWS", () => {
  it("defines create with preflight then gate-quick", () => {
    expect(WORKFLOWS.create.map((s) => s.name)).toEqual(["preflight", "gate-quick"]);
  });

  it("defines plan with route-plan using --prompt argv", () => {
    expect(WORKFLOWS.plan.map((s) => s.name)).toEqual(["preflight", "route-plan"]);
    expect(WORKFLOWS.plan[1]?.argv("/proj", FIXTURE)).toEqual([
      "--prompt",
      "plan implementation",
      "--format",
      "json",
    ]);
    expect(WORKFLOWS.plan[1]?.argv("/proj", FIXTURE, { prompt: "plan next task" })).toEqual([
      "--prompt",
      "plan next task",
      "--format",
      "json",
    ]);
  });
});

describe("resolveWorkflowSteps", () => {
  it("skips preflight by default for token savings", () => {
    expect(resolveWorkflowSteps("create").map((s) => s.name)).toEqual(["gate-quick"]);
    expect(resolveWorkflowSteps("plan").map((s) => s.name)).toEqual(["route-plan"]);
  });

  it("includes preflight when opts.preflight is true", () => {
    expect(
      resolveWorkflowSteps("create", { preflight: true }).map((s) => s.name)
    ).toEqual(["preflight", "gate-quick"]);
  });
});

describe("runWorkflow", () => {
  it("runs create gate-quick only by default (no preflight)", async () => {
    mockedExeca.mockResolvedValueOnce({
      exitCode: 0,
      stdout: '{"gate":"ok"}',
      stderr: "",
    } as Awaited<ReturnType<typeof execa>>);

    const onStep = vi.fn();
    const result = await runWorkflow(FIXTURE, "/proj", "create", { onStep });

    expect(result.status).toBe("ok");
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0]?.name).toBe("gate-quick");
    expect(mockedExeca).toHaveBeenCalledTimes(1);
    expect(mockedExeca.mock.calls[0]?.[1]?.[0]).toBe(
      join(FIXTURE, "codex-execution-quality-gate/scripts/auto_gate.py")
    );
  });

  it("runs create with preflight when --preflight", async () => {
    mockedExeca
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: '{"preflight":"ok"}',
        stderr: "",
      } as Awaited<ReturnType<typeof execa>>)
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: '{"gate":"ok"}',
        stderr: "",
      } as Awaited<ReturnType<typeof execa>>);

    const result = await runWorkflow(FIXTURE, "/proj", "create", { preflight: true });

    expect(result.status).toBe("ok");
    expect(result.steps).toHaveLength(2);
    expect(mockedExeca.mock.calls[0]?.[2]).toEqual({
      reject: false,
      timeout: RUNTIME_HOOK_TIMEOUT,
    });
  });

  it("runs plan route-plan only without preflight", async () => {
    mockedExeca.mockResolvedValueOnce({
      exitCode: 0,
      stdout: '{"intent":"plan"}',
      stderr: "",
    } as Awaited<ReturnType<typeof execa>>);

    const result = await runWorkflow(FIXTURE, "/proj", "plan", {
      prompt: "plan next task",
    });

    expect(result.status).toBe("ok");
    expect(mockedExeca).toHaveBeenCalledTimes(1);
    expect(mockedExeca.mock.calls[0]?.[1]?.[0]).toBe(
      join(FIXTURE, ".system/scripts/prompt_router.py")
    );
    expect(mockedExeca.mock.calls[0]?.[1]?.slice(1)).toEqual([
      "--prompt",
      "plan next task",
      "--format",
      "json",
    ]);
  });

  it("stops create workflow when gate-quick fails", async () => {
    mockedExeca.mockResolvedValueOnce({
      exitCode: 1,
      stdout: "",
      stderr: "gate failed",
    } as Awaited<ReturnType<typeof execa>>);

    const result = await runWorkflow(FIXTURE, "/proj", "create");

    expect(result.status).toBe("failed");
    expect(result.steps).toHaveLength(1);
    expect(mockedExeca).toHaveBeenCalledTimes(1);
  });

  it("throws when an approval step runs without yes", async () => {
    await expect(runWorkflow(FIXTURE, "/proj", "handoff")).rejects.toThrow(
      ApprovalRequiredError
    );
    expect(mockedExeca).toHaveBeenCalledTimes(1);
  });

  it("enforces maximum allowed security level", async () => {
    // Level 2 max capability prevents workflow execution (requires Level 5 run_command)
    await expect(
      runWorkflow(FIXTURE, "/proj", "create", { maxSecurityLevel: 2 })
    ).rejects.toThrow(/requires Level 5 capability/);
  });

  it("bypasses security check if the tool is whitelisted", async () => {
    mockedExeca.mockResolvedValueOnce({
      exitCode: 0,
      stdout: '{"gate":"ok"}',
      stderr: "",
    } as Awaited<ReturnType<typeof execa>>);

    const result = await runWorkflow(FIXTURE, "/proj", "create", {
      maxSecurityLevel: 2,
      securityWhitelist: ["run_command"],
    });

    expect(result.status).toBe("ok");
  });
});
