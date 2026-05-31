import { describe, expect, it } from "vitest";
import { getHarnessConfig, inferHarnessMode, runWithVerificationHarness } from "../skill/harness.js";

describe("getHarnessConfig", () => {
  it("returns default mode without extra options", () => {
    expect(getHarnessConfig("default")).toEqual({ mode: "default" });
  });

  it("configures long-reasoning with maxTurns and rigor hint", () => {
    expect(getHarnessConfig("long-reasoning")).toEqual({
      mode: "long-reasoning",
      maxTurns: 40,
      hintSkills: ["codex-reasoning-rigor"],
    });
  });

  it("configures long-runner with checkpointEvery and subagent hint", () => {
    expect(getHarnessConfig("long-runner")).toEqual({
      mode: "long-runner",
      checkpointEvery: 1,
      hintSkills: ["codex-subagent-execution"],
    });
  });
});

describe("inferHarnessMode", () => {
  it("maps known skills to harness modes", () => {
    expect(inferHarnessMode("codex-reasoning-rigor")).toBe("long-reasoning");
    expect(inferHarnessMode("codex-subagent-execution")).toBe("long-runner");
    expect(inferHarnessMode("codex-plan-writer")).toBe("default");
  });
});

describe("runWithVerificationHarness", () => {
  it("succeeds on the first attempt if verification passes", async () => {
    let executeCalls = 0;
    const execute = async (attempt: number) => {
      executeCalls++;
      return "result-1";
    };
    const verify = async () => ({
      passed: true,
      exitCode: 0,
      stdout: "ok",
      stderr: "",
    });

    const res = await runWithVerificationHarness(execute, verify, { maxAttempts: 3 });
    expect(res.success).toBe(true);
    expect(res.attempts).toBe(1);
    expect(res.output).toBe("result-1");
    expect(executeCalls).toBe(1);
  });

  it("retries and succeeds on the second attempt if first fails and second passes", async () => {
    let executeCalls = 0;
    const execute = async (attempt: number, lastError?: string) => {
      executeCalls++;
      if (attempt === 2) {
        expect(lastError).toContain("Exit Code: 1");
      }
      return `result-${attempt}`;
    };
    let verifyCalls = 0;
    const verify = async () => {
      verifyCalls++;
      if (verifyCalls === 1) {
        return { passed: false, exitCode: 1, stdout: "error in 1", stderr: "" };
      }
      return { passed: true, exitCode: 0, stdout: "ok", stderr: "" };
    };

    const res = await runWithVerificationHarness(execute, verify, { maxAttempts: 3 });
    expect(res.success).toBe(true);
    expect(res.attempts).toBe(2);
    expect(res.output).toBe("result-2");
    expect(executeCalls).toBe(2);
  });

  it("fails after maxAttempts are exhausted", async () => {
    let executeCalls = 0;
    const execute = async (attempt: number) => {
      executeCalls++;
      return `result-${attempt}`;
    };
    let verifyCalls = 0;
    const verify = async () => {
      verifyCalls++;
      return {
        passed: false,
        exitCode: 1,
        stdout: `always fail - attempt ${verifyCalls}`,
        stderr: "",
      };
    };

    const res = await runWithVerificationHarness(execute, verify, { maxAttempts: 3 });
    expect(res.success).toBe(false);
    expect(res.attempts).toBe(3);
    expect(res.output).toBe("result-3");
    expect(executeCalls).toBe(3);
  });
});

