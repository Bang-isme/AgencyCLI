import { Box, Text } from "ink";
import type { ContextBreakdown, ContextSegmentId } from "@agency/core";
import type { ThemeTokens } from "../themes/registry.js";
import { formatTokenCount } from "../utils/text.js";

const SEGMENT_COLORS: Record<ContextSegmentId, (theme: ThemeTokens) => string> = {
  systemPrompt: (t) => t.muted,
  toolDefinitions: (t) => t.accent,
  rules: (t) => t.success,
  skills: (t) => t.warning,
  subagentDefinitions: (t) => t.highlight,
  summarizedConversation: (t) => t.danger,
  conversation: (t) => t.text,
  inflightResponse: (t) => t.highlight,
};

export interface ContextUsagePanelProps {
  theme: ThemeTokens;
  breakdown: ContextBreakdown;
  width?: number;
}

export function ContextUsagePanel({ theme, breakdown, width = 48 }: ContextUsagePanelProps) {
  const { segments, totalTokens, contextWindow, percent, sessionOnlyTokens } = breakdown;
  const barWidth = Math.max(20, width - 4);
  const ctxColor = percent > 80 ? theme.danger : percent > 50 ? theme.warning : theme.success;

  const filledBlocks = segments.flatMap((seg) => {
    const share = totalTokens > 0 ? seg.tokens / totalTokens : 0;
    const blocks = Math.max(share > 0 ? 1 : 0, Math.round(share * barWidth));
    const color = SEGMENT_COLORS[seg.id](theme);
    return Array.from({ length: blocks }, () => ({ color, id: seg.id }));
  });

  while (filledBlocks.length > barWidth) filledBlocks.pop();
  while (filledBlocks.length < barWidth) {
    filledBlocks.push({ color: theme.dimBorder, id: "conversation" as ContextSegmentId });
  }

  return (
    <Box flexDirection="column" marginTop={1}>
      <Text color={theme.text} bold>
        Context Usage
      </Text>
      <Box flexDirection="row" justifyContent="space-between" marginTop={0}>
        <Text color={ctxColor}>
          {percent}% Full
        </Text>
        <Text color={theme.muted}>
          ~{formatTokenCount(totalTokens)} / {formatTokenCount(contextWindow)} Tokens
        </Text>
      </Box>
      <Box flexDirection="row" marginTop={0}>
        {filledBlocks.map((b, i) => (
          <Text key={`ctx-bar-${i}`} color={b.color}>
            █
          </Text>
        ))}
      </Box>
      {segments.map((seg) => (
        <Box key={seg.id} flexDirection="row" marginTop={0}>
          <Text color={SEGMENT_COLORS[seg.id](theme)}>■ </Text>
          <Text color={theme.muted}>{seg.label}: </Text>
          <Text color={theme.text}>{formatTokenCount(seg.tokens)}</Text>
        </Box>
      ))}
      <Text color={theme.muted} dimColor wrap="wrap">
        {breakdown.includesInflight
          ? "Turn payload + in-flight streaming response"
          : breakdown.fromTurnPayload
            ? "Turn payload (system + history sent to provider)"
            : `Session est. · transcript only ~${formatTokenCount(sessionOnlyTokens)}`}
      </Text>
    </Box>
  );
}
