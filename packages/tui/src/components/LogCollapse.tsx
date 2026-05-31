import { memo } from "react";
import { Box, Text } from "ink";
import type { ThemeTokens } from "../themes/registry.js";
import { useDisclosure } from "../state/DisclosureProvider.js";
import { SEVERITY_GLYPHS } from "../motion/design-system.js";

export type LogSeverity = "info" | "warning" | "error" | "debug";

export interface LogEntry {
  message: string;
  severity: LogSeverity;
  /** Timestamp label (e.g. "12:04:32") */
  time?: string;
}

export interface LogCollapseProps {
  theme: ThemeTokens;
  /** All log entries */
  entries: LogEntry[];
  /** Title for the collapsed summary */
  title?: string;
  /** Maximum entries to show before collapsing */
  maxVisible?: number;
}

function severityColor(theme: ThemeTokens, severity: LogSeverity): string {
  switch (severity) {
    case "info":
      return theme.muted;
    case "warning":
      return theme.warning;
    case "error":
      return theme.danger;
    case "debug":
      return theme.muted;
  }
}

function severityIcon(severity: LogSeverity): string {
  switch (severity) {
    case "info":
      return SEVERITY_GLYPHS.info;
    case "warning":
      return SEVERITY_GLYPHS.warning;
    case "error":
      return SEVERITY_GLYPHS.error;
    case "debug":
      return SEVERITY_GLYPHS.debug;
  }
}

/**
 * Smart log collapsing component.
 *
 * By default:
 * - Hides noise (debug, repetitive info)
 * - Collapses successful repetitive validations
 * - Shows only warnings and errors
 *
 * In advanced/expert disclosure levels: shows all entries.
 *
 * Expands on user toggle for full diagnostics.
 */
export const LogCollapse = memo(function LogCollapse({
  theme,
  entries,
  title = "Logs",
  maxVisible = 5,
}: LogCollapseProps) {
  const { level } = useDisclosure();
  const expanded = level === "expert";

  // In default mode: show only warnings/errors
  // In advanced: show all up to maxVisible
  // In expert or expanded: show everything
  const filteredEntries =
    level === "default" && !expanded
      ? entries.filter((e) => e.severity === "warning" || e.severity === "error")
      : entries;

  const showAll = level === "expert" || expanded;
  const visibleEntries = showAll
    ? filteredEntries
    : filteredEntries.slice(0, maxVisible);

  const hiddenCount = filteredEntries.length - visibleEntries.length;
  const suppressedCount = entries.length - filteredEntries.length;

  // Count by severity for the summary
  const errorCount = entries.filter((e) => e.severity === "error").length;
  const warnCount = entries.filter((e) => e.severity === "warning").length;

  // Don't render if nothing to show
  if (entries.length === 0) return null;

  // If all entries are suppressed in default mode and no errors/warnings, show just a summary
  if (visibleEntries.length === 0 && level === "default") {
    return (
      <Box flexDirection="row">
        <Text color={theme.muted} dimColor>
          {title}: {entries.length} entries (all passing) · ctrl+d to expand
        </Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      {/* Header with severity counts */}
      <Box flexDirection="row">
        <Text color={theme.muted} dimColor>
          {title}
        </Text>
        {errorCount > 0 ? (
          <Text color={theme.danger}> · {errorCount} error{errorCount > 1 ? "s" : ""}</Text>
        ) : null}
        {warnCount > 0 ? (
          <Text color={theme.warning}> · {warnCount} warning{warnCount > 1 ? "s" : ""}</Text>
        ) : null}
      </Box>

      {/* Visible entries */}
      {visibleEntries.map((entry, i) => (
        <Box key={i} flexDirection="row" overflow="hidden">
          {entry.time ? (
            <Text color={theme.muted} dimColor>
              {entry.time}{" "}
            </Text>
          ) : null}
          <Text color={severityColor(theme, entry.severity)}>
            {severityIcon(entry.severity)}{" "}
          </Text>
          <Text
            color={
              entry.severity === "error"
                ? theme.danger
                : entry.severity === "warning"
                  ? theme.warning
                  : theme.muted
            }
            dimColor={entry.severity === "debug"}
            wrap="truncate"
          >
            {entry.message}
          </Text>
        </Box>
      ))}

      {/* Collapsed indicator */}
      {hiddenCount > 0 ? (
        <Text color={theme.muted} dimColor>
          +{hiddenCount} more · ctrl+d expand
        </Text>
      ) : null}
      {suppressedCount > 0 && level === "default" ? (
        <Text color={theme.muted} dimColor>
          {suppressedCount} passing entries hidden
        </Text>
      ) : null}
    </Box>
  );
});
