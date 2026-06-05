import React from "react";
import { Box, Text } from "ink";
import type { ThemeTokens } from "../themes/registry.js";
import { scrollbarMetrics } from "../state/scrollbar.js";

export interface ScrollbarProps {
  theme: ThemeTokens;
  /** Total content rows (e.g. virtualLinesCount). */
  total: number;
  /** Current top scroll offset. */
  offset: number;
  /** Scrollbar height in rows == the visible viewport == the track length. */
  height: number;
}

/**
 * A flat 1-column scrollbar drawn at the right edge of the transcript (flag
 * `mouseSupport`). It is deliberately a thin column — NEVER a bordered box,
 * which would clip — and it only *reflects* the scroll model; the offset is
 * still owned by the caller. The thumb position comes from the pure
 * {@link scrollbarMetrics}. Keyboard scroll (↑/↓, PageUp/Down) moves it today;
 * thumb-drag/track-click ride the same column once mouse delivery is wired.
 */
export function Scrollbar({ theme, total, offset, height }: ScrollbarProps): React.ReactElement {
  const rows = Math.max(1, Math.floor(height));
  const { thumbSize, thumbTop } = scrollbarMetrics(total, rows, offset);

  const cells: React.ReactNode[] = [];
  for (let i = 0; i < rows; i++) {
    const isThumb = i >= thumbTop && i < thumbTop + thumbSize;
    cells.push(
      <Text key={i} color={isThumb ? theme.accent : theme.dimBorder} dimColor={!isThumb}>
        {isThumb ? "█" : "│"}
      </Text>
    );
  }

  return (
    <Box flexDirection="column" width={1} height={rows} flexShrink={0}>
      {cells}
    </Box>
  );
}
