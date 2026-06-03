import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { buildFileTreeSection, buildContextPack } from "../context/pack.js";
import { writeIndex, buildIndex } from "../index/workspace-indexer.js";
import type { RouteResult } from "../router/model-router.js";
import type { TokenBudgetPlan } from "../context/token-policy.js";

const dirs: string[] = [];

afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs.length = 0;
});

describe("pack", () => {
  it("buildFileTreeSection generates indented file tree organized by folder", () => {
    const root = mkdtempSync(join(tmpdir(), "agency-pack-"));
    dirs.push(root);
    mkdirSync(join(root, "src"), { recursive: true });
    mkdirSync(join(root, "src", "chat"), { recursive: true });
    writeFileSync(join(root, "package.json"), "{}", "utf8");
    writeFileSync(join(root, "README.md"), "# Hello", "utf8");
    writeFileSync(join(root, "src", "chat", "orchestrator.ts"), "content", "utf8");
    writeIndex(root, buildIndex(root));

    const tree = buildFileTreeSection(root);
    expect(tree).toContain("## Workspace File Tree");
    expect(tree).toContain("- package.json");
    expect(tree).toContain("- README.md");
    expect(tree).toContain("- src/");
    expect(tree).toContain("  - chat/");
    expect(tree).toContain("    - orchestrator.ts");
  });

  it("injects an absolute references-dir hint for an active skill that ships references/", () => {
    const skillsRoot = mkdtempSync(join(tmpdir(), "agency-skills-"));
    dirs.push(skillsRoot);
    // resolveSkillsRoot() only accepts a root that has .system/manifest.json.
    mkdirSync(join(skillsRoot, ".system"), { recursive: true });
    writeFileSync(
      join(skillsRoot, ".system", "manifest.json"),
      JSON.stringify({ skills: ["codex-refskill", "codex-norefskill"] }),
      "utf8"
    );
    const refSkillDir = join(skillsRoot, "codex-refskill");
    mkdirSync(join(refSkillDir, "references"), { recursive: true });
    writeFileSync(
      join(refSkillDir, "SKILL.md"),
      "---\nname: codex-refskill\ndescription: A skill with reference data.\n---\n## Body\nALWAYS read `references/data.md`.\n",
      "utf8"
    );
    writeFileSync(join(refSkillDir, "references", "data.md"), "# Data\n", "utf8");
    // A skill that ships NO references/ dir → must NOT get the (false) hint.
    const bareSkillDir = join(skillsRoot, "codex-norefskill");
    mkdirSync(bareSkillDir, { recursive: true });
    writeFileSync(
      join(bareSkillDir, "SKILL.md"),
      "---\nname: codex-norefskill\ndescription: A skill with no references.\n---\n## Body\nJust guidance.\n",
      "utf8"
    );

    const prev = process.env.AGENCY_SKILLS_ROOT;
    process.env.AGENCY_SKILLS_ROOT = skillsRoot;
    try {
      const root = mkdtempSync(join(tmpdir(), "agency-pack-skills-"));
      dirs.push(root);
      writeFileSync(join(root, "package.json"), "{}", "utf8");
      writeIndex(root, buildIndex(root));

      const plan: TokenBudgetPlan = {
        mode: "normal", maxContextFiles: 5, maxContextChars: 20000, maxLlmOutputTokens: 1024,
        allowPreflight: false, includeFullRouteJson: false, useRouteCache: false,
      };
      const base: RouteResult = { intent: "build", workflow: "implement", provider: "openai", skills: [], warnings: [] };

      const withRefs = buildContextPack(root, { ...base, skills: ["codex-refskill"] }, plan);
      const refsDir = join(refSkillDir, "references");
      expect(withRefs).toContain("### Skill: codex-refskill");
      expect(withRefs).toContain(refsDir); // the absolute path the model can actually read
      expect(withRefs).toContain("read one with read_file");

      const noRefs = buildContextPack(root, { ...base, skills: ["codex-norefskill"] }, plan);
      expect(noRefs).toContain("### Skill: codex-norefskill");
      expect(noRefs).not.toContain("read one with read_file");
    } finally {
      if (prev === undefined) delete process.env.AGENCY_SKILLS_ROOT;
      else process.env.AGENCY_SKILLS_ROOT = prev;
    }
  });

  it("surfaces an absolute hint to the active workflow's .workflows/<name>.md (flag-gated)", () => {
    const skillsRoot = mkdtempSync(join(tmpdir(), "agency-skills-wf-"));
    dirs.push(skillsRoot);
    mkdirSync(join(skillsRoot, ".system"), { recursive: true });
    writeFileSync(
      join(skillsRoot, ".system", "manifest.json"),
      JSON.stringify({ skills: [] }),
      "utf8"
    );
    mkdirSync(join(skillsRoot, ".workflows"), { recursive: true });
    writeFileSync(
      join(skillsRoot, ".workflows", "plan.md"),
      "---\nname: plan\nloads: [codex-plan-writer]\n---\n1. Step one.\n",
      "utf8"
    );

    const prev = process.env.AGENCY_SKILLS_ROOT;
    process.env.AGENCY_SKILLS_ROOT = skillsRoot;
    try {
      const root = mkdtempSync(join(tmpdir(), "agency-pack-wf-"));
      dirs.push(root);
      writeFileSync(join(root, "package.json"), "{}", "utf8");
      writeIndex(root, buildIndex(root));

      const plan: TokenBudgetPlan = {
        mode: "normal", maxContextFiles: 5, maxContextChars: 20000, maxLlmOutputTokens: 1024,
        allowPreflight: false, includeFullRouteJson: false, useRouteCache: false,
      };
      const route: RouteResult = { intent: "other", workflow: "plan", provider: "openai", skills: [], warnings: [] };
      const wfPath = join(skillsRoot, ".workflows", "plan.md");

      // Flag on → the absolute workflow-definition path is reachable in the pack.
      process.env.AGENCY_WORKFLOW_SKILL_LOADS = "1";
      const withHint = buildContextPack(root, route, plan);
      expect(withHint).toContain("# ACTIVE WORKFLOW");
      expect(withHint).toContain(wfPath);

      // Flag off (legacy) → byte-identical, no workflow hint.
      process.env.AGENCY_WORKFLOW_SKILL_LOADS = "0";
      const noHint = buildContextPack(root, route, plan);
      expect(noHint).not.toContain("# ACTIVE WORKFLOW");
    } finally {
      delete process.env.AGENCY_WORKFLOW_SKILL_LOADS;
      if (prev === undefined) delete process.env.AGENCY_SKILLS_ROOT;
      else process.env.AGENCY_SKILLS_ROOT = prev;
    }
  });

  it("buildContextPack includes the file tree and file contents", () => {
    const root = mkdtempSync(join(tmpdir(), "agency-pack-context-"));
    dirs.push(root);
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "package.json"), "{}", "utf8");
    writeFileSync(join(root, "src", "foo.ts"), "console.log('test')", "utf8");
    writeIndex(root, buildIndex(root));

    const route: RouteResult = {
      intent: "read",
      workflow: "none",
      provider: "openai",
      skills: [],
      warnings: [],
    };

    const plan: TokenBudgetPlan = {
      mode: "normal",
      maxContextFiles: 5,
      maxContextChars: 12000,
      maxLlmOutputTokens: 1024,
      allowPreflight: false,
      includeFullRouteJson: false,
      useRouteCache: false,
    };

    const context = buildContextPack(root, route, plan);
    expect(context).toContain("# Context");
    expect(context).toContain("## Workspace File Tree");
    expect(context).toContain("- package.json");
    expect(context).toContain("- src/");
    expect(context).toContain("  - foo.ts");
  });
});
