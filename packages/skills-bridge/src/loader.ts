import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveSkillAlias } from "./aliases.js";

export interface SkillsManifest {
  skills?: string[];
}

export function loadManifestSkills(skillsRoot: string): string[] {
  const manifestPath = join(skillsRoot, ".system", "manifest.json");
  const raw = readFileSync(manifestPath, "utf8");
  const manifest = JSON.parse(raw) as SkillsManifest;
  return Array.isArray(manifest.skills) ? manifest.skills : [];
}

export function resolveSkillName(input: string): string {
  return resolveSkillAlias(input);
}

export function skillMdPath(skillsRoot: string, skillName: string): string {
  return join(skillsRoot, skillName, "SKILL.md");
}

export function resolveSkillMdPath(skillsRoot: string, input: string): string {
  const skillName = resolveSkillName(input);
  const path = skillMdPath(skillsRoot, skillName);
  if (!existsSync(path)) {
    throw new Error(`SKILL.md not found for "${input}" (resolved: ${skillName}) at ${path}`);
  }
  return path;
}
