import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadManifestSkills, skillMdPath } from "@agency/skills-bridge";
import { MANIFEST_AGENTS } from "@agency/core";

/**
 * Structural-integrity guard for the bundled skills pack (`packages/cli/skills`).
 *
 * The production-hardening initiative's signature defect is "machinery built but
 * not wired" — and at the skills/agents layer that shows up two ways: a SKILL.md
 * added on disk but forgotten in the manifest (built-but-unwired → never loaded),
 * or a manifest entry with no SKILL.md (advertised-but-missing → runtime error on
 * invoke). The agent routing space can drift the same way. Nothing previously
 * asserted these invariants, so they could silently rot. This test fails loudly
 * on any drift, in `pnpm verify`.
 *
 * Reuses the real loaders (`loadManifestSkills`, `skillMdPath`) and the canonical
 * agent constant (`MANIFEST_AGENTS`) rather than re-implementing path logic. This
 * lives in @agency/cli because it is the only package that (a) bundles the skills
 * pack and (b) sits atop the dep graph so it can import `MANIFEST_AGENTS` from
 * core — core depends on skills-bridge, so the check cannot live there.
 */

const PKG_ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "../..");
const SKILLS_ROOT = join(PKG_ROOT, "skills");
const MANIFEST_PATH = join(SKILLS_ROOT, ".system", "manifest.json");

interface FullManifest {
  skills?: string[];
  agents?: string[];
  workflows?: string[];
  load_order?: { always?: string[]; "on-demand"?: string[] };
}

function readManifest(): FullManifest {
  return JSON.parse(readFileSync(MANIFEST_PATH, "utf8")) as FullManifest;
}

/** Top-level skill dirs on disk (those that directly contain a SKILL.md). */
function diskSkillDirs(): string[] {
  return readdirSync(SKILLS_ROOT).filter((name) => {
    if (name.startsWith(".")) return false; // .system holds meta-skills, not pack skills
    const dir = join(SKILLS_ROOT, name);
    try {
      return statSync(dir).isDirectory() && existsSync(join(dir, "SKILL.md"));
    } catch {
      return false;
    }
  });
}

describe("bundled skills pack integrity", () => {
  it("ships the manifest at the bundled skills root", () => {
    expect(existsSync(MANIFEST_PATH)).toBe(true);
  });

  it("every manifest skill has a readable SKILL.md (no advertised-but-missing)", () => {
    const skills = loadManifestSkills(SKILLS_ROOT);
    expect(skills.length).toBeGreaterThan(0);
    const missing = skills.filter((s) => !existsSync(skillMdPath(SKILLS_ROOT, s)));
    expect(missing).toEqual([]);
  });

  it("every on-disk SKILL.md is declared in the manifest (no built-but-unwired skill)", () => {
    const declared = new Set(loadManifestSkills(SKILLS_ROOT));
    const orphans = diskSkillDirs().filter((d) => !declared.has(d));
    expect(orphans).toEqual([]);
  });

  it("manifest agents match the code's MANIFEST_AGENTS dispatch space exactly", () => {
    const declared = (readManifest().agents ?? []).slice().sort();
    const code = [...MANIFEST_AGENTS].sort();
    expect(declared).toEqual(code);
  });

  it("every load_order entry references a declared skill (no dangling load reference)", () => {
    const declared = new Set(loadManifestSkills(SKILLS_ROOT));
    const order = readManifest().load_order ?? {};
    const referenced = [...(order.always ?? []), ...(order["on-demand"] ?? [])];
    const dangling = referenced.filter((s) => !declared.has(s));
    expect(dangling).toEqual([]);
  });
});
