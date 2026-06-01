/**
 * Safe terminal dimensions for Ink layout.
 *
 * Windows Terminal toggles a vertical scrollbar when output reaches the last
 * column, shrinking `stdout.columns` by 1 and retriggering Ink — a flicker loop.
 * Wide/fullscreen windows hit this more often because rows stretch to the edge.
 */

/** Responsive margin: wider terminals need more edge clearance (Yoga rounding). */
export function scrollbarMargin(_cols: number): number {
  return 1;
}

export interface TerminalLayout {
  cols: number;
  rows: number;
  shellWidth: number;
  contentWidth: number;
  /** Bordered input / slash menu outer width — extra edge clearance. */
  composerWidth: number;
  /** Text area inside composer border + paddingX(1). */
  composerInnerWidth: number;
  shellHeight: number;
}

export function layoutWidth(cols: number): number {
  return Math.max(20, cols - 2);
}

export function contentWidth(cols: number): number {
  return layoutWidth(cols);
}

/** Outer width for bordered composer panels (input, slash/@ menus). */
export function composerWidth(cols: number): number {
  return layoutWidth(cols);
}

/** Usable text width inside composer border box with paddingX(1). */
export function composerInnerWidth(cols: number): number {
  return Math.max(8, composerWidth(cols) - 4);
}

export function measureTerminal(cols = 80, rows = 24): TerminalLayout {
  const width = layoutWidth(cols);
  return {
    cols,
    rows,
    shellWidth: width,
    contentWidth: width,
    composerWidth: width,
    composerInnerWidth: Math.max(8, width - 4),
    shellHeight: Math.max(10, rows - 1),
  };
}

/** Horizontal rule length for a box of the given outer width. */
export function dividerRepeat(boxWidth: number): string {
  return "─".repeat(Math.max(0, boxWidth));
}

/** Message border inner repeat count — keeps ╭──╮ within innerWidth. */
export function borderCharCount(innerWidth: number): number {
  return Math.max(3, innerWidth - 3);
}

import { truncateText as visualTruncate } from "../utils/text.js";
export { visualTruncate as truncateText };

/** Cap overlay/panel width while staying inside safe content bounds. */
export function panelWidth(cols: number, max = 96, min = 40): number {
  const currentWidth = contentWidth(cols);
  if (currentWidth < min) {
    return currentWidth;
  }
  return Math.min(currentWidth, max);
}

