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

/** Absolute path to a workflow definition file (`.workflows/<name>.md`). */
export function workflowMdPath(skillsRoot: string, workflowName: string): string {
  return join(skillsRoot, ".workflows", `${workflowName}.md`);
}

/**
 * The skill chain a workflow declares it loads — the `loads: [a, b, c]`
 * frontmatter line in `.workflows/<name>.md`. This is the workflow's intended
 * skill pipeline (e.g. `plan` → intent-analyzer + plan-writer + workflow-autopilot
 * + reasoning-rigor), the single source of truth the runtime activates when that
 * workflow is selected. Returns [] for an unknown workflow or a file with no
 * `loads:` line. Never throws — a malformed pack must not break routing.
 */
export function workflowSkillLoads(skillsRoot: string, workflowName: string): string[] {
  try {
    const path = workflowMdPath(skillsRoot, workflowName);
    if (!existsSync(path)) return [];
    const raw = readFileSync(path, "utf8");
    // `loads:` lives in the leading YAML-ish frontmatter as an inline array.
    const m = raw.match(/^loads:\s*\[([^\]]*)\]/m);
    if (!m) return [];
    const out: string[] = [];
    const seen = new Set<string>();
    for (const part of m[1]!.split(",")) {
      const name = part.trim();
      // Only accept well-formed skill slugs so a stray token can't become a
      // phantom skill load.
      if (/^[a-z0-9][a-z0-9-]*$/.test(name) && !seen.has(name)) {
        seen.add(name);
        out.push(name);
      }
    }
    return out;
  } catch {
    return [];
  }
}
