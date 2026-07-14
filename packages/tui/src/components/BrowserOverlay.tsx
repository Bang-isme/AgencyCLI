import { useState, useEffect } from "react";
import { Box, Text, useInput } from "ink";
import type { ThemeTokens } from "../themes/registry.js";
import { useTerminalLayout } from "../layout/TerminalLayoutProvider.js";

export interface BrowserOverlayProps {
  theme: ThemeTokens;
  projectRoot: string;
  onOpen: (url: string) => void;
  onClose: () => void;
}

export function BrowserOverlay({
  theme,
  projectRoot,
  onOpen,
  onClose,
}: BrowserOverlayProps) {
  const { cols } = useTerminalLayout();
  const [url, setUrl] = useState("");
  const [mcpStatus, setMcpStatus] = useState<{ configured: boolean; hint: string }>({
    configured: false,
    hint: "",
  });

  useEffect(() => {
    import("@agency/core").then(({ getBrowserMcpStatus }) => {
      setMcpStatus(getBrowserMcpStatus(projectRoot));
    });
  }, [projectRoot]);

  useInput((input, key) => {
    if (key.escape) {
      onClose();
      return;
    }

    if (key.return) {
      const trimmed = url.trim();
      if (trimmed) {
        onOpen(trimmed);
      }
      return;
    }

    const isBackspace =
      key.backspace ||
      input === "\b" ||
      input === "\x08" ||
      input === "\x7f";

    if (isBackspace) {
      setUrl((prev) => prev.slice(0, -1));
      return;
    }

    // Ignore escape/arrows/tabs/control characters
    if (
      key.upArrow ||
      key.downArrow ||
      key.leftArrow ||
      key.rightArrow ||
      key.tab ||
      input.includes("\x1b") ||
      input.charCodeAt(0) < 32
    ) {
      return;
    }

    setUrl((prev) => prev + input);
  });

  const overlayWidth = Math.min(cols - 4, 60);
  const innerWidth = overlayWidth - 6;
  const dividerStr = "─".repeat(Math.max(0, innerWidth));

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={theme.accent}
      paddingX={2}
      width={overlayWidth}
      overflow="hidden"
    >
      <Box marginTop={1} overflow="hidden">
        <Text bold color={theme.accent}>
          🌐 Browser & Web Tools
        </Text>
      </Box>
      <Text color={theme.dimBorder}>{dividerStr}</Text>

      <Box flexDirection="column" marginY={1} overflow="hidden">
        <Box flexDirection="row" overflow="hidden">
          <Text color={theme.muted}>MCP Configured: </Text>
          <Text color={mcpStatus.configured ? theme.success : theme.danger} bold>
            {mcpStatus.configured ? "✓ Yes" : "x No"}
          </Text>
        </Box>
        {!mcpStatus.configured && mcpStatus.hint ? (
          <Box marginTop={1} overflow="hidden">
            <Text color={theme.warning} wrap="wrap">
              💡 {mcpStatus.hint}
            </Text>
          </Box>
        ) : null}
      </Box>

      <Text color={theme.dimBorder}>{dividerStr}</Text>

      <Box flexDirection="column" marginY={1} overflow="hidden">
        <Text color={theme.text} bold>
          Open Web Page
        </Text>
        <Box flexDirection="row" marginTop={1} overflow="hidden">
          <Text color={theme.muted}>URL: </Text>
          <Box
            flexGrow={1}
            borderStyle="single"
            borderColor={theme.dimBorder}
            paddingX={1}
            overflow="hidden"
          >
            <Text color={theme.text}>
              {url || "https://example.com"}
            </Text>
          </Box>
        </Box>
      </Box>

      <Text color={theme.dimBorder}>{dividerStr}</Text>
      <Box marginBottom={1} overflow="hidden">
        <Text color={theme.muted}>
          Enter open page · Esc cancel
        </Text>
      </Box>
    </Box>
  );
}
