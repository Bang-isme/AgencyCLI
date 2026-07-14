import { useState } from "react";
import { Box, Text, useInput } from "ink";
import { listThemeIds, type ThemeId, type ThemeTokens } from "../themes/registry.js";
import { useTerminalLayout } from "../layout/TerminalLayoutProvider.js";

export interface ThemeOverlayProps {
  theme: ThemeTokens;
  currentThemeId: string;
  onPreview: (themeId: ThemeId) => void;
  onSelect: (themeId: ThemeId) => void;
  onClose: () => void;
}

export function ThemeOverlay({
  theme,
  currentThemeId,
  onPreview,
  onSelect,
  onClose,
}: ThemeOverlayProps) {
  const { cols } = useTerminalLayout();
  const themeIds = listThemeIds();
  
  // Find current index
  const initialIndex = themeIds.indexOf(currentThemeId as ThemeId);
  const [selectedIndex, setSelectedIndex] = useState(initialIndex !== -1 ? initialIndex : 0);

  useInput((_input, key) => {
    if (key.escape) {
      onClose();
      return;
    }
    if (key.return) {
      onSelect(themeIds[selectedIndex]!);
      return;
    }
    if (key.upArrow) {
      setSelectedIndex((prev) => {
        const next = prev > 0 ? prev - 1 : themeIds.length - 1;
        onPreview(themeIds[next]!);
        return next;
      });
      return;
    }
    if (key.downArrow) {
      setSelectedIndex((prev) => {
        const next = prev < themeIds.length - 1 ? prev + 1 : 0;
        onPreview(themeIds[next]!);
        return next;
      });
      return;
    }
  });

  const overlayWidth = Math.min(cols - 4, 50);
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
          ✦ Theme Selector
        </Text>
      </Box>
      <Text color={theme.dimBorder}>{dividerStr}</Text>

      <Box flexDirection="column" marginY={1} overflow="hidden">
        {themeIds.map((id, idx) => {
          const isSelected = idx === selectedIndex;
          const isActiveTheme = id === currentThemeId;
          const arrow = isSelected ? "> " : "  ";
          
          return (
            <Box key={id} flexDirection="row" overflow="hidden">
              <Text color={isSelected ? theme.accent : theme.muted} bold={isSelected}>
                {arrow}
              </Text>
              <Box marginRight={2}>
                <Text
                  color={isSelected ? theme.bg : theme.text}
                  backgroundColor={isSelected ? theme.accent : undefined}
                  bold={isSelected}
                >
                  {` ${id} `}
                </Text>
              </Box>
              <Text color={theme.muted}>
                {isActiveTheme ? "(active)" : ""}
              </Text>
            </Box>
          );
        })}
      </Box>

      <Text color={theme.dimBorder}>{dividerStr}</Text>
      <Box marginBottom={1} overflow="hidden">
        <Text color={theme.muted}>
          ↑↓ navigate · Enter select · Esc cancel
        </Text>
      </Box>
    </Box>
  );
}
