import { loadAgencyConfig, type ProviderId } from "@agency/providers";
import { routePrompt } from "./prompt-bridge.js";
import { heuristicRoute } from "./fallback-router.js";
import { applyWeightsToRoute, loadWeights } from "./weights.js";

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
  return result;
}
