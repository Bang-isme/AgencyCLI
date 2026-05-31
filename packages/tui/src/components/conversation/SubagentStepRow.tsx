import React, { memo } from "react";
import { Box, Text } from "ink";
import type { ThemeTokens } from "../../themes/registry.js";
import { useTick } from "../../motion/useTick.js";
import { SPINNER_DOTS, LIFECYCLE_GLYPHS } from "../../motion/design-system.js";
import { translateSubLineLabel } from "../../utils/conversation/tool-labels.js";

export function formatTechnicalSubLine(text: string, theme: ThemeTokens): React.ReactNode {
  let cleanText = text.trim();

  // 0. Highlight diff prefixes at start of line
  let diffPrefixNode: React.ReactNode = null;
  if (cleanText.startsWith("+ ")) {
    diffPrefixNode = <Text color={theme.success} bold>+ </Text>;
    cleanText = cleanText.slice(2).trim();
  } else if (cleanText.startsWith("- ")) {
    diffPrefixNode = <Text color={theme.danger} bold>- </Text>;
    cleanText = cleanText.slice(2).trim();
  } else if (cleanText.startsWith("~ ")) {
    diffPrefixNode = <Text color={theme.warning} bold>~ </Text>;
    cleanText = cleanText.slice(2).trim();
  }

  // 1. Highlight Phase X
  const phaseMatch = cleanText.match(/^(Phase \d+):?/i);
  let phaseNode: React.ReactNode = null;
  if (phaseMatch) {
    const phaseStr = phaseMatch[1]!;
    phaseNode = (
      <Text color={theme.warning} bold>
        {phaseStr}{" "}
      </Text>
    );
    cleanText = cleanText.slice(phaseMatch[0].length).trim();
    if (cleanText.startsWith(":") || cleanText.startsWith("-")) {
      cleanText = cleanText.slice(1).trim();
    }
  }

  // 2. Highlight status at start of subline
  const statusMatch = cleanText.match(/^(Running|Done|Completed|Failed|Pending|Verified|Created|Modified|Deleted)\b/i);
  let statusNode: React.ReactNode = null;
  if (statusMatch) {
    const statusStr = statusMatch[1]!;
    let color = theme.text;
    let icon = "";
    if (["done", "completed", "verified", "created"].includes(statusStr.toLowerCase())) {
      color = theme.success;
      icon = "✓ ";
    } else if (["running"].includes(statusStr.toLowerCase())) {
      color = theme.accent;
      icon = "→ ";
    } else if (["failed"].includes(statusStr.toLowerCase())) {
      color = theme.danger;
      icon = "✕ ";
    } else if (["pending"].includes(statusStr.toLowerCase())) {
      color = theme.muted;
      icon = "● ";
    } else if (["modified", "deleted"].includes(statusStr.toLowerCase())) {
      color = theme.warning;
      icon = "~ ";
    }
    statusNode = (
      <Text color={color} bold>
        {icon}{statusStr}{" "}
      </Text>
    );
    cleanText = cleanText.slice(statusMatch[0].length).trim();
  }

  // 3. Highlight stats inside parentheses, e.g. (1m 21s | 42.5k tokens)
  const parenMatch = cleanText.match(/\(([^)]+)\)/);
  let mainText = cleanText;
  let statsNode: React.ReactNode = null;

  if (parenMatch) {
    const inside = parenMatch[1]!;
    mainText = cleanText.slice(0, parenMatch.index).trim();

    const parts = inside.split("|");
    const formattedParts = parts.map((part, pIdx) => {
      const trimmedPart = part.trim();
      if (/\d+m\s+\d+s|\d+s|\d+ms/i.test(trimmedPart)) {
        return (
          <Text key={pIdx} color={theme.accent}>
            {trimmedPart}
          </Text>
        );
      }
      if (/\d+(?:\.\d+)?k?\s+tokens/i.test(trimmedPart)) {
        return (
          <Text key={pIdx} color={theme.warning}>
            {trimmedPart}
          </Text>
        );
      }
      return <Text key={pIdx} color={theme.text}>{trimmedPart}</Text>;
    });

    const joinedElements: React.ReactNode[] = [];
    formattedParts.forEach((partEl, idx) => {
      if (idx > 0) {
        joinedElements.push(
          <Text key={`pipe-${idx}`} color={theme.muted}>
            {" | "}
          </Text>
        );
      }
      joinedElements.push(partEl);
    });

    statsNode = (
      <Text color={theme.muted}>
        {"("}
        {joinedElements}
        {")"}
      </Text>
    );
  }

  // 4. Highlight file paths / commands in mainText
  const fileWords = mainText.split(/(\s+)/);
  const formattedMainText = fileWords.map((word, wIdx) => {
    const trimmed = word.trim();
    const isFile = trimmed.includes(".") && (
      trimmed.endsWith(".ts") ||
      trimmed.endsWith(".tsx") ||
      trimmed.endsWith(".js") ||
      trimmed.endsWith(".jsx") ||
      trimmed.endsWith(".json") ||
      trimmed.endsWith(".md") ||
      trimmed.endsWith(".py") ||
      trimmed.endsWith(".yaml") ||
      trimmed.endsWith(".yml") ||
      trimmed.includes("/") ||
      trimmed.includes("\\")
    );
    if (isFile) {
      return (
        <Text key={wIdx} color={theme.success} bold>
          {word}
        </Text>
      );
    }
    return <Text key={wIdx} color={theme.text}>{word}</Text>;
  });

  return (
    <Box flexDirection="row">
      {diffPrefixNode}
      {phaseNode}
      {statusNode}
      <Box flexDirection="row">
        {formattedMainText}
      </Box>
      {statsNode ? <Text> </Text> : null}
      {statsNode}
    </Box>
  );
}

export interface SubagentStepRowProps {
  treeConnector: string;
  status: "done" | "active" | "pending";
  label: string;
  theme: ThemeTokens;
}

export const SubagentStepRow = memo(function SubagentStepRow({
  treeConnector,
  status,
  label,
  theme,
}: SubagentStepRowProps) {
  const isActive = status === "active";
  const tick = useTick(isActive, 100);

  const stepIcon = status === "done"
    ? `${LIFECYCLE_GLYPHS.done} `
    : isActive
      ? SPINNER_DOTS[tick % SPINNER_DOTS.length] + " "
      : `${LIFECYCLE_GLYPHS.pending} `;

  const stepColor = status === "done"
    ? theme.success
    : isActive
      ? theme.accent
      : theme.muted;

  return (
    <Box flexDirection="row" marginLeft={2}>
      <Text color={theme.accent}>
        {treeConnector}
      </Text>
      <Text color={stepColor} bold={isActive}>
        {stepIcon}
      </Text>
      <Box flexGrow={1} overflow="hidden">
        {formatTechnicalSubLine(translateSubLineLabel(label), theme)}
      </Box>
    </Box>
  );
});
