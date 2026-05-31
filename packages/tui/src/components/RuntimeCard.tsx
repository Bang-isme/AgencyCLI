import { memo, type ReactNode } from "react";
import { Box, Text } from "ink";
import type { ThemeTokens } from "../themes/registry.js";
import { useTerminalLayout } from "../layout/TerminalLayoutProvider.js";

/**
 * Attention tier determines visual priority of the card.
 * - primary: bold accent, high contrast (actions, approvals, alerts)
 * - secondary: normal text (findings, progress, validation)
 * - tertiary: muted/dim (paths, timestamps, metadata)
 * - background: dim collapsed (telemetry, traces, diagnostics)
 */
export type AttentionTier = "primary" | "secondary" | "tertiary" | "background";

export interface RuntimeCardProps {
  theme: ThemeTokens;
  /** Concise operational title (e.g. "Auth cluster identified") */
  title: string;
  /** Attention tier drives visual weight */
  tier?: AttentionTier;
  /** Optional phase/status tag shown right of title */
  tag?: string;
  /** Tag color override */
  tagColor?: string;
  /** Key-value metadata pairs displayed below title */
  meta?: Array<{ key: string; value: string }>;
  /** Structured findings list */
  findings?: string[];
  /** Child content for custom body */
  children?: ReactNode;
  /** Collapsed state — shows only title row when true */
  collapsed?: boolean;
}

function tierColor(theme: ThemeTokens, tier: AttentionTier): string {
  switch (tier) {
    case "primary":
      return theme.accent;
    case "secondary":
      return theme.text;
    case "tertiary":
      return theme.muted;
    case "background":
      return theme.muted;
  }
}

function tierBorder(theme: ThemeTokens, tier: AttentionTier): string {
  switch (tier) {
    case "primary":
      return theme.accent;
    case "secondary":
      return theme.border;
    case "tertiary":
      return theme.dimBorder;
    case "background":
      return theme.dimBorder;
  }
}

/**
 * Structured runtime output card.
 *
 * Replaces markdown prose with calm, scannable operational panels.
 * Follows information hierarchy: title → tag → meta → findings → body.
 */
export const RuntimeCard = memo(function RuntimeCard({
  theme,
  title,
  tier = "secondary",
  tag,
  tagColor,
  meta,
  findings,
  children,
  collapsed = false,
}: RuntimeCardProps) {
  const { composerWidth } = useTerminalLayout();
  const titleColor = tierColor(theme, tier);
  const borderColor = tierBorder(theme, tier);
  const isDim = tier === "tertiary" || tier === "background";

  return (
    <Box
      flexDirection="column"
      borderStyle="single"
      borderColor={borderColor}
      paddingX={1}
      width={Math.min(composerWidth, composerWidth - 2)}
      overflow="hidden"
      marginY={0}
    >
      {/* Title Row */}
      <Box flexDirection="row" justifyContent="space-between" overflow="hidden">
        <Text color={titleColor} bold={tier === "primary"} dimColor={isDim} wrap="truncate">
          {title}
        </Text>
        {tag ? (
          <Text color={tagColor ?? theme.muted} dimColor={isDim}>
            {tag}
          </Text>
        ) : null}
      </Box>

      {collapsed ? null : (
        <>
          {/* Metadata key-value pairs */}
          {meta && meta.length > 0 ? (
            <Box flexDirection="column" marginTop={0}>
              {meta.map(({ key, value }) => (
                <Box key={key} flexDirection="row">
                  <Text color={theme.muted} dimColor>
                    {key}:{" "}
                  </Text>
                  <Text color={tier === "primary" ? theme.text : theme.muted}>
                    {value}
                  </Text>
                </Box>
              ))}
            </Box>
          ) : null}

          {/* Findings list */}
          {findings && findings.length > 0 ? (
            <Box flexDirection="column" marginTop={0}>
              {findings.map((finding, i) => (
                <Text key={i} color={theme.text} dimColor={isDim} wrap="truncate">
                  {"  "}• {finding}
                </Text>
              ))}
            </Box>
          ) : null}

          {/* Custom body */}
          {children ? (
            <Box flexDirection="column" marginTop={0}>
              {children}
            </Box>
          ) : null}
        </>
      )}
    </Box>
  );
});
