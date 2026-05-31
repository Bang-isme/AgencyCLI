import { describe, expect, it } from "vitest";
import { resolveSkillAlias, SKILL_ALIASES } from "../aliases.js";

describe("resolveSkillAlias", () => {
  it("maps registered aliases to skill ids", () => {
    expect(resolveSkillAlias("$plan")).toBe("codex-plan-writer");
    expect(resolveSkillAlias("$tdd")).toBe("codex-test-driven-development");
    expect(resolveSkillAlias("$gate")).toBe("codex-execution-quality-gate");
    expect(resolveSkillAlias("$hook")).toBe("codex-runtime-hook");
    expect(resolveSkillAlias("$sdd")).toBe("codex-subagent-execution");
  });

  it("normalizes bare names and unknown $ aliases", () => {
    expect(resolveSkillAlias("plan-writer")).toBe("codex-plan-writer");
    expect(resolveSkillAlias("$unknown-skill")).toBe("codex-unknown-skill");
    expect(resolveSkillAlias("codex-demo")).toBe("codex-demo");
  });

  it("exposes at least 15 aliases from manifest skills", () => {
    expect(Object.keys(SKILL_ALIASES).length).toBeGreaterThanOrEqual(15);
  });

  it("maps documented workflow and discipline aliases to shipped skills", () => {
    expect(resolveSkillAlias("$debug")).toBe("codex-systematic-debugging");
    expect(resolveSkillAlias("$create")).toBe("codex-workflow-autopilot");
    expect(resolveSkillAlias("$prototype")).toBe("codex-workflow-autopilot");
    expect(resolveSkillAlias("$review")).toBe("codex-workflow-autopilot");
    expect(resolveSkillAlias("$deploy")).toBe("codex-workflow-autopilot");
    expect(resolveSkillAlias("$handoff")).toBe("codex-workflow-autopilot");
    expect(resolveSkillAlias("$refactor")).toBe("codex-workflow-autopilot");
    expect(resolveSkillAlias("$root-cause")).toBe("codex-systematic-debugging");
    expect(resolveSkillAlias("$trace")).toBe("codex-systematic-debugging");
    expect(resolveSkillAlias("$dispatch")).toBe("codex-subagent-execution");
    expect(resolveSkillAlias("$worktree")).toBe("codex-git-worktrees");
    expect(resolveSkillAlias("$finish")).toBe("codex-branch-finisher");
    expect(resolveSkillAlias("$finish-branch")).toBe("codex-branch-finisher");
    expect(resolveSkillAlias("$evidence")).toBe("codex-verification-discipline");
  });
});
