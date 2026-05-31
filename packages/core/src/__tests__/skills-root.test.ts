import { describe, it, expect } from "vitest";
import { resolveSkillsRoot } from "../skills-root.js";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("resolveSkillsRoot", () => {
  it("prefers AGENCY_SKILLS_ROOT when manifest exists", () => {
    const dir = mkdtempSync(join(tmpdir(), "skills-"));
    mkdirSync(join(dir, ".system"), { recursive: true });
    writeFileSync(join(dir, ".system", "manifest.json"), "{}");
    const prev = process.env.AGENCY_SKILLS_ROOT;
    process.env.AGENCY_SKILLS_ROOT = dir;
    try {
      expect(resolveSkillsRoot()).toBe(dir);
    } finally {
      if (prev === undefined) delete process.env.AGENCY_SKILLS_ROOT;
      else process.env.AGENCY_SKILLS_ROOT = prev;
    }
  });

  it("resolves to local packages/cli/skills in development monorepo structure", () => {
    const prev = process.env.AGENCY_SKILLS_ROOT;
    delete process.env.AGENCY_SKILLS_ROOT;
    try {
      const root = resolveSkillsRoot();
      expect(root).toContain("cli");
      expect(root).toContain("skills");
    } finally {
      if (prev !== undefined) process.env.AGENCY_SKILLS_ROOT = prev;
    }
  });
});
