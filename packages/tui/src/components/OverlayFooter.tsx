import { Box, Text } from "ink";
import type { ThemeTokens } from "../themes/registry.js";
import { useTerminalLayout } from "../layout/TerminalLayoutProvider.js";

export interface OverlayFooterProps {
  theme: ThemeTokens;
  actions: string[];
}

export function OverlayFooter({ theme, actions }: OverlayFooterProps) {
  const { contentWidth } = useTerminalLayout();
  const innerWidth = Math.min(76, contentWidth - 8);

  const fullText = actions.join(" · ");
  const compactText = innerWidth >= 30 ? fullText : actions.map((a) => a.replace(/ /g, ":")).join(" · ");

  return (
    <Box flexDirection="column">
      <Text color={theme.dimBorder}>
        {"─".repeat(Math.max(0, innerWidth))}
      </Text>
      <Box justifyContent="center">
        <Text color={theme.muted}>{compactText}</Text>
      </Box>
    </Box>
  );
}
