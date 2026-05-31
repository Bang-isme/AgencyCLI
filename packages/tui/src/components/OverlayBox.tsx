import { Box, type BoxProps } from "ink";
import type { ThemeTokens } from "../themes/registry.js";

export interface OverlayBoxProps extends BoxProps {
  theme: ThemeTokens;
  children?: React.ReactNode;
}

export function OverlayBox({ theme, children, ...props }: OverlayBoxProps) {
  return (
    <Box borderStyle="round" borderColor={theme.accent} {...props}>
      {children}
    </Box>
  );
}
