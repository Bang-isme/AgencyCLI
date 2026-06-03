import { useState, type ReactNode } from "react";
import { Box, Text } from "ink";
import type { ThemeTokens } from "../themes/registry.js";
import { ShimmerText } from "../components/AnimatedText.js";
import { wrapText } from "../utils/text.js";

export interface PendingApproval {
  toolName: string;
  purpose?: string;
  safetyPolicy?: string;
  shellCommand?: string;
  fileWritePath?: string;
  fileWriteContent?: string;
  riskLevel?: string;
  confidenceLevel?: string;
  validationStatus?: string;
  pausedCount?: number;
  queuedSafeCount?: number;
  budgetExceeded?: boolean;
}

export interface ApprovalProps {
  theme: ThemeTokens;
  pending: PendingApproval | null;
  width?: number;
}

export function Approval({ theme, pending, width }: ApprovalProps) {
  const [showDiff] = useState(true);

  if (!pending) {
    return <Text color={theme.muted}>No pending approval.</Text>;
  }

  const title = pending.shellCommand
    ? "Approve shell command"
    : `Approve ${pending.toolName}`;

  const isHighRisk = pending.riskLevel === "HIGH" || pending.budgetExceeded;
  const isMediumRisk = pending.riskLevel === "MEDIUM";
  const isLowRisk = pending.riskLevel === "LOW";

  // An approval is requested BECAUSE the action mutates/destroys. When the risk
  // wasn't actually assessed (no riskLevel on this path), default to caution
  // (warning), NOT success/green — a green "all clear" border on an un-assessed
  // destructive action is a fabricated safety signal.
  const borderColor = isHighRisk
    ? theme.danger
    : isMediumRisk
    ? theme.warning
    : isLowRisk
    ? theme.success
    : theme.warning;

  const boxWidth = width ?? 70;
  const innerWidth = boxWidth - 6;

  // Wrap shell command to avoid broken borders
  const shellWrapWidth = innerWidth - 4;
  const formattedCommand = pending.shellCommand
    ? wrapText(pending.shellCommand, shellWrapWidth).join("\n")
    : "";

  // Wrap file content to avoid broken borders
  const codeWrapWidth = innerWidth - 4;
  const formattedContent = pending.fileWriteContent
    ? wrapText(
        pending.fileWriteContent.length > 500
          ? pending.fileWriteContent.substring(0, 500) + "\n... (truncated)"
          : pending.fileWriteContent,
        codeWrapWidth,
        { preserveIndent: true }
      ).join("\n")
    : "";

  // Only surface trust metadata that is REAL. Never fabricate "Confidence: HIGH"
  // / "Validation: PASSED" defaults — this path sets neither, so a hardcoded
  // default would be a fake assessment shown on a security gate (it lulls the
  // user into approving). When nothing real is present, the row is omitted.
  const trustSegments: ReactNode[] = [];
  if (pending.confidenceLevel) {
    trustSegments.push(
      <Text key="conf" color={theme.text}>Confidence: <Text color={theme.success} bold>{pending.confidenceLevel}</Text></Text>
    );
  }
  if (pending.validationStatus) {
    trustSegments.push(
      <Text key="val" color={theme.text}>Validation: <Text color={theme.success} bold>{pending.validationStatus}</Text></Text>
    );
  }
  if (pending.pausedCount !== undefined) {
    trustSegments.push(<Text key="paused" color={theme.warning} bold>◷ {pending.pausedCount} Paused</Text>);
  }
  if (pending.queuedSafeCount !== undefined) {
    trustSegments.push(<Text key="queued" color={theme.success} bold>+ {pending.queuedSafeCount} Queued Safe</Text>);
  }

  return (
    <Box
      flexDirection="column"
      marginTop={1}
      borderStyle="round"
      borderColor={borderColor}
      paddingX={2}
      paddingY={1}
      width={boxWidth}
    >
      <Box marginBottom={1} flexDirection="row" justifyContent="space-between" width={innerWidth}>
        <ShimmerText text={`■  ${title.toUpperCase()}`} theme={theme} bold />
        {pending.riskLevel ? (
          <Box paddingX={1}>
            <Text backgroundColor={isHighRisk ? theme.danger : isMediumRisk ? theme.warning : theme.success} color="black" bold>
              {" "}{pending.riskLevel} RISK{" "}
            </Text>
          </Box>
        ) : null}
      </Box>

      {pending.budgetExceeded ? (
        <Box marginBottom={1} paddingX={1} width={innerWidth}>
          <Text backgroundColor={theme.danger} color="black" bold>
            {" "}Safe Interruption Budget Exceeded — Security Emergency Override Applied!{" "}
          </Text>
        </Box>
      ) : null}

      {/* Trust metadata — rendered only when a REAL assessment is present. */}
      {trustSegments.length > 0 ? (
        <Box
          flexDirection="row"
          borderStyle="single"
          borderColor={theme.border}
          paddingX={1}
          marginBottom={1}
          width={innerWidth}
        >
          {trustSegments.map((seg, i) => (
            <Box key={i} flexDirection="row">
              {i > 0 ? <Text color={theme.dimBorder}>{"  |  "}</Text> : null}
              {seg}
            </Box>
          ))}
        </Box>
      ) : null}

      {pending.shellCommand ? (
        <Box borderStyle="single" borderColor={theme.border} paddingX={1} marginBottom={1} width={innerWidth}>
          <Text color={theme.text}>{formattedCommand}</Text>
        </Box>
      ) : null}

      {pending.fileWritePath ? (
        <Box flexDirection="column" marginBottom={1} width={innerWidth}>
          <Text color={theme.text} bold>
            Target file: <Text color={theme.success}>{pending.fileWritePath}</Text>
          </Text>
          {showDiff && pending.fileWriteContent ? (
            <Box borderStyle="single" borderColor={theme.border} paddingX={1} marginTop={1} flexDirection="column" width={innerWidth}>
              <Text color={theme.muted}>[Edits proposed]</Text>
              <Text color={theme.success}>{formattedContent}</Text>
            </Box>
          ) : null}
        </Box>
      ) : null}

      {pending.purpose ? (
        <Box marginBottom={1} width={innerWidth}>
          <Text color={theme.muted}>{pending.purpose}</Text>
        </Box>
      ) : null}

      {pending.safetyPolicy ? (
        <Box marginBottom={1} width={innerWidth}>
          <Text color={theme.danger} italic>{pending.safetyPolicy}</Text>
        </Box>
      ) : null}

      {/* Simplified Spacious Actions & Footer shortcuts */}
      <Box borderStyle="double" borderColor={theme.border} paddingX={2} paddingY={0} marginTop={1} flexDirection="row" width={innerWidth} justifyContent="space-around">
        <Text color={theme.success} bold>[y] Approve</Text>
        <Text color={theme.warning} bold>[a] Auto-Approve (All)</Text>
        <Text color={theme.danger} bold>[n] Deny</Text>
      </Box>
    </Box>
  );
}
