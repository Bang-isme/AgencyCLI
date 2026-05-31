import { memo } from "react";
import { Box, Text } from "ink";
import type { ThemeTokens } from "../themes/registry.js";
import { dividerRepeat } from "./terminal-layout.js";

export interface HeaderProps {
  theme: ThemeTokens;
  project: string;
  modelHint?: string;
  modelName?: string;
  thinkingLabel?: string;
  loading?: boolean;
  width?: number;
}

function shortPath(project: string, max = 60): string {
  if (project.length <= max) return project;
  return `…${project.slice(-(max - 1))}`;
}

export const Header = memo(function Header({
  theme,
  project,
  width,
}: HeaderProps) {
  const shellWidth = width ?? 80;
  const pathMax = Math.max(12, shellWidth - 22);

  return (
    <Box flexDirection="column" width={shellWidth} overflow="hidden">
      <Box flexDirection="row" justifyContent="space-between" width={shellWidth} overflow="hidden">
        <Text>
          <Text color={theme.muted}># </Text>
          <Text color={theme.text} bold>acg</Text>
          <Text color={theme.muted}> v0.1.0</Text>
        </Text>
        <Text color={theme.muted} wrap="truncate">
          {shortPath(project, pathMax)}
        </Text>
      </Box>
      <Box width={shellWidth} height={1} overflow="hidden">
        <Text color={theme.dimBorder}>{dividerRepeat(shellWidth)}</Text>
      </Box>
    </Box>
  );
});
