import { memo } from "react";
import { Box, Text } from "ink";
import type { ThemeTokens } from "../themes/registry.js";

export type ConfidenceLevel = "high" | "medium" | "low";
export type RiskLevel = "low" | "medium" | "high" | "critical";
export type ValidationState = "passed" | "passed_with_warnings" | "failed" | "pending";

export interface TrustCardProps {
  theme: ThemeTokens;
  confidence?: ConfidenceLevel;
  risk?: RiskLevel;
  validation?: ValidationState;
  /** Optional rollback state indicator */
  rollbackReady?: boolean;
  /** Whether to show in compact inline mode */
  inline?: boolean;
}

function confidenceColor(theme: ThemeTokens, level: ConfidenceLevel): string {
  switch (level) {
    case "high":
      return theme.success;
    case "medium":
      return theme.warning;
    case "low":
      return theme.danger;
  }
}

function riskColor(theme: ThemeTokens, level: RiskLevel): string {
  switch (level) {
    case "low":
      return theme.success;
    case "medium":
      return theme.warning;
    case "high":
      return theme.danger;
    case "critical":
      return theme.danger;
  }
}

function validationColor(theme: ThemeTokens, state: ValidationState): string {
  switch (state) {
    case "passed":
      return theme.success;
    case "passed_with_warnings":
      return theme.warning;
    case "failed":
      return theme.danger;
    case "pending":
      return theme.muted;
  }
}

function validationLabel(state: ValidationState): string {
  switch (state) {
    case "passed":
      return "PASSED";
    case "passed_with_warnings":
      return "PASSED (warnings)";
    case "failed":
      return "FAILED";
    case "pending":
      return "PENDING";
  }
}

/**
 * Trust visibility card: exposes confidence, risk, and validation state
 * as visually separated dimensions. Makes runtime trust transparent.
 */
export const TrustCard = memo(function TrustCard({
  theme,
  confidence,
  risk,
  validation,
  rollbackReady,
  inline = false,
}: TrustCardProps) {
  if (inline) {
    // Compact single-line mode for embedding in other cards
    const parts: Array<{ label: string; color: string }> = [];
    if (confidence) {
      parts.push({ label: `Confidence: ${confidence.toUpperCase()}`, color: confidenceColor(theme, confidence) });
    }
    if (risk) {
      parts.push({ label: `Risk: ${risk.toUpperCase()}`, color: riskColor(theme, risk) });
    }
    if (validation) {
      parts.push({ label: `Validation: ${validationLabel(validation)}`, color: validationColor(theme, validation) });
    }

    return (
      <Box flexDirection="row">
        {parts.map((part, i) => (
          <Box key={part.label} flexDirection="row">
            {i > 0 ? <Text color={theme.dimBorder}> · </Text> : null}
            <Text color={part.color}>{part.label}</Text>
          </Box>
        ))}
        {rollbackReady ? (
          <>
            <Text color={theme.dimBorder}> · </Text>
            <Text color={theme.muted}>Rollback ready</Text>
          </>
        ) : null}
      </Box>
    );
  }

  // Block layout: each dimension on its own line
  return (
    <Box flexDirection="column">
      {confidence ? (
        <Box flexDirection="row">
          <Text color={theme.muted}>Confidence  </Text>
          <Text color={confidenceColor(theme, confidence)} bold>
            {confidence.toUpperCase()}
          </Text>
        </Box>
      ) : null}
      {risk ? (
        <Box flexDirection="row">
          <Text color={theme.muted}>Risk        </Text>
          <Text color={riskColor(theme, risk)} bold>
            {risk.toUpperCase()}
          </Text>
        </Box>
      ) : null}
      {validation ? (
        <Box flexDirection="row">
          <Text color={theme.muted}>Validation  </Text>
          <Text color={validationColor(theme, validation)} bold>
            {validationLabel(validation)}
          </Text>
        </Box>
      ) : null}
      {rollbackReady ? (
        <Box flexDirection="row">
          <Text color={theme.muted}>Rollback    </Text>
          <Text color={theme.success}>READY</Text>
        </Box>
      ) : null}
    </Box>
  );
});
