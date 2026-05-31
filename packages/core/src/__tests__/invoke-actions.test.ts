import { writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { getInvokeActions } from "../skill/invoke-actions.js";

describe("getInvokeActions", () => {
  let projectRoot: string;

  afterEach(() => {
    if (projectRoot) {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it("suggests task start when plan.md exists", () => {
    projectRoot = mkdtempSync(join(tmpdir(), "agency-invoke-plan-"));
    writeFileSync(join(projectRoot, "plan.md"), "# Plan\n");

    const actions = getInvokeActions("codex-plan-writer", projectRoot);
    expect(actions).toEqual(["agency task start plan.md"]);
  });

  it("suggests chat when no plan file", () => {
    projectRoot = mkdtempSync(join(tmpdir(), "agency-invoke-no-plan-"));

    const actions = getInvokeActions("codex-plan-writer", projectRoot);
    expect(actions).toEqual(['agency chat "create plan for <your goal>"']);
  });

  it("suggests agents dispatch for subagent execution", () => {
    projectRoot = mkdtempSync(join(tmpdir(), "agency-invoke-sdd-"));

    const actions = getInvokeActions("codex-subagent-execution", projectRoot);
    expect(actions[0]).toContain("agency agents dispatch planner");
  });

  it("includes workflow run create for gate skill", () => {
    projectRoot = mkdtempSync(join(tmpdir(), "agency-invoke-gate-"));

    const actions = getInvokeActions("codex-execution-quality-gate", projectRoot);
    expect(actions[0]).toBe("agency workflow run create");
  });

  it("falls back to skill show for unknown skills", () => {
    projectRoot = mkdtempSync(join(tmpdir(), "agency-invoke-other-"));

    const actions = getInvokeActions("codex-demo", projectRoot);
    expect(actions).toEqual(["agency skill show codex-demo"]);
  });
});
