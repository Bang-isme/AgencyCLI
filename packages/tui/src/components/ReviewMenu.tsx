import { useState } from "react";
import { Box, Text, useInput } from "ink";
import type { ThemeTokens } from "../themes/registry.js";

export interface ReviewAction {
  id: string;
  label: string;
  icon: string;
  prompt: string;
}

export const REVIEW_ACTIONS: ReviewAction[] = [
  {
    id: "commit",
    label: "Last commit",
    icon: "📝",
    prompt: "$git review the last commit — summarize changes, check quality, flag issues",
  },
  {
    id: "branch",
    label: "Current branch",
    icon: "🌿",
    prompt: "$git review the current branch vs main — summarize all changes, identify risks",
  },
  {
    id: "pr",
    label: "Pull request",
    icon: "🔀",
    prompt: "$git review this as a pull request — check for breaking changes, test coverage, code quality",
  },
  {
    id: "ci",
    label: "CI/CD status",
    icon: "⚙",
    prompt: "$git check CI/CD pipeline status and recent build results",
  },
];

export interface ReviewMenuProps {
  theme: ThemeTokens;
  onSelect: (action: ReviewAction) => void;
  onClose: () => void;
}

export function ReviewMenu({
  theme,
  onSelect,
  onClose,
}: ReviewMenuProps) {
  const [index, setIndex] = useState(0);

  const safe = index % REVIEW_ACTIONS.length;

  useInput((_input, key) => {
    if (key.escape) {
      onClose();
      return;
    }
    if (key.upArrow) {
      setIndex((i) => Math.max(0, i - 1));
      return;
    }
    if (key.downArrow) {
      setIndex((i) => Math.min(REVIEW_ACTIONS.length - 1, i + 1));
      return;
    }
    if (key.return) {
      const item = REVIEW_ACTIONS[safe];
      if (item) onSelect(item);
    }
  });

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={theme.accent}
      paddingX={2}
      paddingY={1}
    >
      <Text color={theme.text} bold>
        Review
      </Text>
      <Text color={theme.muted} dimColor>
        Code review powered by CodexAI Skills
      </Text>
      <Box marginTop={1} flexDirection="column">
        {REVIEW_ACTIONS.map((action, i) => {
          const sel = i === safe;
          return (
            <Box key={action.id} flexDirection="row" alignItems="center">
              <Box width={3}>
                <Text color={sel ? theme.accent : theme.muted}>{sel ? "▸" : " "}</Text>
              </Box>
              <Box width={4}>
                <Text color={sel ? theme.accent : theme.muted}>{action.icon}</Text>
              </Box>
              <Box flexGrow={1}>
                <Text color={sel ? theme.text : theme.muted} bold={sel}>
                  {action.label}
                </Text>
              </Box>
            </Box>
          );
        })}
      </Box>
      <Box marginTop={1}>
        <Text color={theme.muted} dimColor>
          Enter to run · ↑↓ navigate · Esc close
        </Text>
      </Box>
    </Box>
  );
}
