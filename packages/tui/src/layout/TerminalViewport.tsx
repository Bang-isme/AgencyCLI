import type { ReactNode } from "react";
import { Box } from "ink";
import { useTerminalLayout } from "./TerminalLayoutProvider.js";
import type { ThemeTokens } from "../themes/registry.js";

export interface TerminalViewportProps {
  theme: ThemeTokens;
  children: ReactNode;
}

/** Full-viewport shell — fills terminal on resize without edge overflow. */
export function TerminalViewport({ theme: _theme, children }: TerminalViewportProps) {
  const { shellWidth, shellHeight } = useTerminalLayout();

  return (
    <Box
      flexDirection="column"
      width={shellWidth}
      height={shellHeight}
      overflow="hidden"
    >
      {children}
    </Box>
  );
}
