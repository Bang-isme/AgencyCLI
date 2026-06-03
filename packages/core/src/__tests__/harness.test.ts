import { describe, expect, it } from "vitest";
import { getHarnessConfig, inferHarnessMode } from "../skill/harness.js";

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

