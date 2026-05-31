import { memo, type ReactNode } from "react";
import { Box, Text } from "ink";
import type { ThemeTokens } from "../themes/registry.js";
import { Header } from "./Header.js";
import { dividerRepeat } from "./terminal-layout.js";
import { useTerminalLayout } from "./TerminalLayoutProvider.js";

export interface ShellProps {
  theme: ThemeTokens;
  project?: string;
  modelHint?: string;
  modelName?: string;
  thinkingLabel?: string;
  loading?: boolean;
  composer?: ReactNode;
  footer?: ReactNode;
  children: ReactNode;
  /** Number of paused tasks/lanes (shown in footer) */
  pausedCount?: number;
}

export const Shell = memo(function Shell({
  theme,
  project = "project",
  modelHint,
  modelName,
  thinkingLabel,
  loading = false,
  composer,
  footer,
  children,
  pausedCount: _pausedCount = 0,
}: ShellProps) {
  const { shellWidth, composerWidth } = useTerminalLayout();

  return (
    <Box flexDirection="column" width={shellWidth} height="100%" overflow="hidden">
      <Box flexShrink={0} width={shellWidth} overflow="hidden">
        <Header
          theme={theme}
          project={project}
          modelHint={modelHint}
          modelName={modelName}
          thinkingLabel={thinkingLabel}
          loading={loading}
          width={shellWidth}
        />
      </Box>

      <Box flexGrow={1} flexDirection="column" overflow="hidden" width={shellWidth} minHeight={0}>
        {children}
      </Box>

      <Box flexShrink={0} flexDirection="column" width={shellWidth}>
        <Box width={shellWidth} height={1} overflow="hidden">
          <Text color={theme.dimBorder}>{dividerRepeat(shellWidth)}</Text>
        </Box>
        <Box width={composerWidth} flexDirection="column" overflow="hidden">
          {composer}
        </Box>
        {footer ? (
          <Box width={composerWidth} overflow="hidden">
            {footer}
          </Box>
        ) : null}
      </Box>
    </Box>
  );
});
