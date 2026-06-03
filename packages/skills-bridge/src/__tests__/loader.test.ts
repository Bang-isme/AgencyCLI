import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { workflowSkillLoads } from "../loader.js";

describe("workflowSkillLoads", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "agency-loader-"));
    mkdirSync(join(root, ".workflows"), { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function writeWorkflow(name: string, frontmatter: string): void {
    writeFileSync(
      join(root, ".workflows", `${name}.md`),
      `---\n${frontmatter}\n---\n# body\n`,
      "utf8"
    );
  }

  it("parses the loads: array in declaration order, deduped", () => {
    writeWorkflow(
      "plan",
      "name: plan\ntrigger: $plan\nloads: [codex-intent-context-analyzer, codex-plan-writer, codex-plan-writer]"
    );
    expect(workflowSkillLoads(root, "plan")).toEqual([
      "codex-intent-context-analyzer",
      "codex-plan-writer",
    ]);
  });

  it("returns [] for an unknown workflow (no file)", () => {
    expect(workflowSkillLoads(root, "does-not-exist")).toEqual([]);
  });

  it("returns [] when the file has no loads: line", () => {
    writeWorkflow("bare", "name: bare\ntrigger: $bare");
    expect(workflowSkillLoads(root, "bare")).toEqual([]);
  });

  it("filters out tokens that are not well-formed skill slugs (no phantom loads)", () => {
    // An uppercase token, a path-traversal token, and an empty entry must all be
    // dropped — the activated set can only ever be real skill slugs.
    writeWorkflow(
      "dirty",
      "loads: [codex-plan-writer, ../escape, BadCase, , codex-reasoning-rigor]"
    );
    expect(workflowSkillLoads(root, "dirty")).toEqual([
      "codex-plan-writer",
      "codex-reasoning-rigor",
    ]);
  });
});
