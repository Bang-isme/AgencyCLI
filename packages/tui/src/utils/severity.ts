import type { ThemeTokens } from "../themes/registry.js";
import type { RuntimeThoughtSeverity } from "@agency/core";
import { SEVERITY_GLYPHS } from "../motion/design-system.js";

/**
 * Theme colour + glyph for a runtime *thought* severity. Shared by the panels
 * that render `RuntimeThoughtEvent`s (CognitionPanel, ExecutionPanel) so the two
 * can't drift apart. Glyphs come from the single-source-of-truth `SEVERITY_GLYPHS`
 * (Windows-safe single-cell markers — note `▲`, deliberately not the double-width
 * `⚠`). Log-line severities ("error"/"debug") are a different domain — see
 * `LogCollapse`.
 */
export function thoughtSeverityColor(
  theme: ThemeTokens,
  severity: RuntimeThoughtSeverity
): string {
  switch (severity) {
    case "info":
      return theme.muted;
    case "adaptation":
      return theme.accent;
    case "warning":
      return theme.warning;
    case "critical":
      return theme.danger;
    default:
      return theme.muted;
  }
}

export function thoughtSeverityIcon(severity: RuntimeThoughtSeverity): string {
  switch (severity) {
    case "info":
      return SEVERITY_GLYPHS.info;
    case "adaptation":
      return SEVERITY_GLYPHS.adaptation;
    case "warning":
      return SEVERITY_GLYPHS.warning;
    case "critical":
      return SEVERITY_GLYPHS.critical;
    default:
      return SEVERITY_GLYPHS.info;
  }
}
