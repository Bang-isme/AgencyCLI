import type { ThemeTokens } from "../themes/registry.js";

/**
 * Resolves the theme color for a given model specification source.
 */
export function getSpecSourceColor(specSource: string | undefined, theme: ThemeTokens): string {
  const source = specSource || "default";
  if (source === "registry" || source === "api" || source === "catalog") {
    return theme.success;
  } else if (source === "override") {
    return theme.accent;
  } else if (source === "heuristics") {
    return theme.warning;
  } else {
    return theme.danger;
  }
}
