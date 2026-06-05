/**
 * Pure geometry for the in-app transcript scrollbar (flag `mouseSupport`).
 *
 * The alternate screen (`?1049h`) has no native scrollback, so the terminal's
 * own scrollbar can never reflect the transcript — we draw our own 1-column
 * indicator at the right edge. This module is the pure, unit-testable math: it
 * maps the scroll model (total lines, visible viewport, current offset) to a
 * thumb position. It holds NO React/IO and creates NO second scroll model — the
 * caller still owns `scrollOffset`/`getMaxScrollOffset`; this only renders it.
 */

export interface ScrollbarMetrics {
  /** Thumb length in rows (≥1). */
  thumbSize: number;
  /** Thumb top in rows from the track top (0 … track−thumbSize). */
  thumbTop: number;
}

/**
 * Thumb size + position for a track exactly as tall as the visible viewport.
 *
 * - `total`    — total content rows (e.g. `virtualLinesCount`).
 * - `viewport` — visible rows == scrollbar height == track length.
 * - `offset`   — current top scroll offset (0 = top).
 *
 * When nothing overflows (`total ≤ viewport`) the thumb fills the whole track.
 * Otherwise the thumb is proportional to the visible fraction (min 1 row) and
 * its top is interpolated across the remaining travel so that offset 0 pins it
 * to the top and the max offset pins it to the bottom.
 */
export function scrollbarMetrics(
  total: number,
  viewport: number,
  offset: number
): ScrollbarMetrics {
  const track = Math.max(1, Math.floor(viewport));
  const totalRows = Math.max(0, Math.floor(total));

  if (totalRows <= track) {
    return { thumbSize: track, thumbTop: 0 };
  }

  const thumbSize = Math.max(1, Math.min(track, Math.round((track / totalRows) * track)));
  const maxThumbTop = track - thumbSize;
  const maxOffset = totalRows - track;
  const clampedOffset = Math.max(0, Math.min(offset, maxOffset));
  const thumbTop = maxOffset === 0
    ? 0
    : Math.round((clampedOffset / maxOffset) * maxThumbTop);

  return { thumbSize, thumbTop: Math.max(0, Math.min(thumbTop, maxThumbTop)) };
}
