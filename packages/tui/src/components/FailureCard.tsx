import { memo } from "react";
import { Box, Text } from "ink";
import type { ThemeTokens } from "../themes/registry.js";
import { useTerminalLayout } from "../layout/TerminalLayoutProvider.js";

export interface FailureCardProps {
  theme: ThemeTokens;
  /** Short operational title (e.g. "Validation failed") */
  title: string;
  /** What happened — one sentence */
  consequence: string;
  /** Recovery path — what the user can do */
  recovery: string;
  /** Optional exact recovery command (rendered as copyable) */
  recoveryCommand?: string;
  /** Whether this failure triggered an automatic rollback */
  rolledBack?: boolean;
  /** Severity: controls border/accent intensity */
  severity?: "warning" | "error" | "critical";
}

/**
 * Calm failure card with clear consequence, recovery path, and optional command.
 *
 * Failures feel recoverable, controlled, and deterministic.
 * NEVER: "Execution crashed." ALWAYS: "Validation failed. Changes rolled back safely."
 */
export const FailureCard = memo(function FailureCard({
  theme,
  title,
  consequence,
  recovery,
  recoveryCommand,
  rolledBack = false,
  severity = "error",
}: FailureCardProps) {
  const { composerWidth } = useTerminalLayout();

  const borderColor =
    severity === "critical"
      ? theme.danger
      : severity === "error"
        ? theme.warning
        : theme.warning;

  const titleColor =
    severity === "critical" ? theme.danger : theme.warning;

  return (
    <Box
      flexDirection="column"
      borderStyle={severity === "critical" ? "double" : "single"}
      borderColor={borderColor}
      paddingX={1}
      width={Math.min(composerWidth, composerWidth - 2)}
      overflow="hidden"
      marginY={0}
    >
      {/* Title */}
      <Box flexDirection="row" justifyContent="space-between">
        <Text color={titleColor} bold>
          {severity === "warning" ? "⚠ " : "✕ "}{title}
        </Text>
        {rolledBack ? (
          <Text color={theme.success}>rolled back safely</Text>
        ) : null}
      </Box>

      {/* Consequence */}
      <Box marginTop={0}>
        <Text color={theme.text}>{consequence}</Text>
      </Box>

      {/* Recovery */}
      <Box marginTop={0}>
        <Text color={theme.muted}>Recovery: </Text>
        <Text color={theme.text}>{recovery}</Text>
      </Box>

      {/* Recovery Command (if provided) */}
      {recoveryCommand ? (
        <Box marginTop={0}>
          <Text color={theme.muted}>  $ </Text>
          <Text color={theme.accent} bold>{recoveryCommand}</Text>
        </Box>
      ) : null}
    </Box>
  );
});
