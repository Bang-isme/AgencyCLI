import { loadAgencyConfig, type ProviderId } from "@agency/providers";
import { routePrompt } from "./prompt-bridge.js";
import { heuristicRoute } from "./fallback-router.js";
import { applyWeightsToRoute, loadWeights } from "./weights.js";
import { SKILL_ALIASES, workflowSkillLoads } from "@agency/skills-bridge";
import { getRuntimeFlags } from "../runtime/flags.js";

/**
 * Skills the user explicitly invoked with a `$alias` in the prompt — e.g. by
 * choosing one in the skills picker, which injects `$design`. They are resolved
 * deterministically against the alias map and merged into the route so the
 * chosen skill's SKILL.md is ALWAYS injected into the context pack, independent
 * of the fuzzy intent router (which only models a handful of skills and could
 * otherwise drop or mis-route an explicitly-selected one — `$design` keyword-
 * matches to `codex-plan-writer`, not `codex-design-system`). Only exact alias
 * keys resolve, so a stray `$5` / `$PATH` / `$var` is never treated as a skill.
 */
export function skillsFromPromptAliases(prompt: string): string[] {
  if (!prompt || prompt.indexOf("$") === -1) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  const re = /\$[A-Za-z][A-Za-z0-9_-]*/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(prompt)) !== null) {
    const skill = SKILL_ALIASES[m[0]];
    if (skill && !seen.has(skill)) {
      seen.add(skill);
      out.push(skill);
    }
  }
  return out;
}

export interface RouteResult {
  intent: string;
  suggested_agent: string | null;
  workflow: string;
  skills: string[];
  provider: ProviderId;
  warnings: string[];
}

export async function routeUserPrompt(
  skillsRoot: string,
  prompt: string,
  projectRoot?: string
): Promise<RouteResult> {
  const provider = loadAgencyConfig().defaultProvider;
  let result: RouteResult;
  try {
    const plugin = await routePrompt(skillsRoot, prompt);
    result = {
      intent: String(plugin.intent ?? "other"),
      suggested_agent: (plugin.suggested_agent as string | null) ?? null,
      workflow: String(plugin.workflow ?? "create"),
      skills: Array.isArray(plugin.skills) ? (plugin.skills as string[]) : [],
      provider,
      warnings: Array.isArray(plugin.warnings) ? (plugin.warnings as string[]) : [],
    };
  } catch (err) {
    // Python router unavailable (not installed, script error, …) — degrade to
    // the built-in heuristic so the CLI keeps working without Python.
    result = heuristicRoute(prompt, provider);
    const reason = err instanceof Error ? err.message : String(err);
    result.warnings = [
      ...result.warnings,
      `Python router unavailable — using built-in heuristic routing (${reason})`,
    ];
  }
  if (projectRoot) {
    const weights = loadWeights(projectRoot);
    if (weights) {
      result = applyWeightsToRoute(result, prompt, weights);
    }
  }
  // An explicitly-typed/selected `$alias` deterministically activates its skill
  // (prepended, deduped) — the chosen skill must not depend on fuzzy routing.
  const explicit = skillsFromPromptAliases(prompt);
  if (explicit.length > 0) {
    const merged: string[] = [];
    const seen = new Set<string>();
    for (const s of [...explicit, ...result.skills]) {
      if (!seen.has(s)) {
        seen.add(s);
        merged.push(s);
      }
    }
    result = { ...result, skills: merged };
  }
  // The selected workflow activates its full declared skill chain. Each
  // `.workflows/<name>.md` lists `loads: [skill, …]` — the pipeline the skill-pack
  // author intended that workflow to run — but the router only emits its own
  // (often narrower) skills, so the workflow's chain never loaded. Merge the
  // workflow's loads AFTER the explicit/router skills (those keep priority) so the
  // whole pipeline reaches the context pack. Flag-gated; off → byte-identical.
  if (getRuntimeFlags().workflowSkillLoads && result.workflow) {
    const loads = workflowSkillLoads(skillsRoot, result.workflow);
    if (loads.length > 0) {
      const merged: string[] = [];
      const seen = new Set<string>();
      for (const s of [...result.skills, ...loads]) {
        if (!seen.has(s)) {
          seen.add(s);
          merged.push(s);
        }
      }
      result = { ...result, skills: merged };
    }
  }
  return result;
}
