import { Box, Text } from "ink";
import type { ThemeTokens } from "../themes/registry.js";
import { animationsEnabled } from "../motion/animations.js";
import { useTerminalLayout } from "../layout/TerminalLayoutProvider.js";
import { useTick } from "../motion/useTick.js";

export interface GlowingLogoProps {
  theme: ThemeTokens;
  tick?: number;
  /** Available width in columns — enables responsive compact mode when < 64 */
  maxWidth?: number;
  /** When false, logo is static — avoids full-screen Ink redraw loops on the chat screen. */
  animated?: boolean;
  height?: number;
}

/*
 * High-resolution pixel bitmaps for AGENCYCLI — 7 rows × 6 cols per letter.
 * Curved letters (A, G, C) have rounded corners for a modern aesthetic.
 * 1 = filled pixel (rendered as █), 0 = empty (rendered as space).
 * Using only █ and space guarantees perfect cell-width alignment
 * on every monospace terminal font (Windows, macOS, Linux).
 *
 * Full grid: 9 letters × 6 cols + 8 gaps × 1 col = 62 total columns.
 */
const BITMAPS_FULL: Record<string, number[][]> = {
  A: [
    [0, 1, 1, 1, 1, 0],
    [1, 0, 0, 0, 0, 1],
    [1, 0, 0, 0, 0, 1],
    [1, 1, 1, 1, 1, 1],
    [1, 0, 0, 0, 0, 1],
    [1, 0, 0, 0, 0, 1],
    [1, 0, 0, 0, 0, 1],
  ],
  G: [
    [0, 1, 1, 1, 1, 0],
    [1, 0, 0, 0, 0, 0],
    [1, 0, 0, 0, 0, 0],
    [1, 0, 0, 1, 1, 1],
    [1, 0, 0, 0, 0, 1],
    [1, 0, 0, 0, 0, 1],
    [0, 1, 1, 1, 1, 0],
  ],
  E: [
    [1, 1, 1, 1, 1, 1],
    [1, 0, 0, 0, 0, 0],
    [1, 0, 0, 0, 0, 0],
    [1, 1, 1, 1, 1, 0],
    [1, 0, 0, 0, 0, 0],
    [1, 0, 0, 0, 0, 0],
    [1, 1, 1, 1, 1, 1],
  ],
  N: [
    [1, 0, 0, 0, 0, 1],
    [1, 1, 0, 0, 0, 1],
    [1, 0, 1, 0, 0, 1],
    [1, 0, 1, 0, 0, 1],
    [1, 0, 0, 1, 0, 1],
    [1, 0, 0, 0, 1, 1],
    [1, 0, 0, 0, 0, 1],
  ],
  C: [
    [0, 1, 1, 1, 1, 0],
    [1, 0, 0, 0, 0, 1],
    [1, 0, 0, 0, 0, 0],
    [1, 0, 0, 0, 0, 0],
    [1, 0, 0, 0, 0, 0],
    [1, 0, 0, 0, 0, 1],
    [0, 1, 1, 1, 1, 0],
  ],
  Y: [
    [1, 0, 0, 0, 0, 1],
    [1, 0, 0, 0, 0, 1],
    [0, 1, 0, 0, 1, 0],
    [0, 0, 1, 1, 0, 0],
    [0, 0, 1, 1, 0, 0],
    [0, 0, 1, 1, 0, 0],
    [0, 0, 1, 1, 0, 0],
  ],
  L: [
    [1, 0, 0, 0, 0, 0],
    [1, 0, 0, 0, 0, 0],
    [1, 0, 0, 0, 0, 0],
    [1, 0, 0, 0, 0, 0],
    [1, 0, 0, 0, 0, 0],
    [1, 0, 0, 0, 0, 0],
    [1, 1, 1, 1, 1, 1],
  ],
  I: [
    [1, 1, 1, 1, 1, 1],
    [0, 0, 1, 1, 0, 0],
    [0, 0, 1, 1, 0, 0],
    [0, 0, 1, 1, 0, 0],
    [0, 0, 1, 1, 0, 0],
    [0, 0, 1, 1, 0, 0],
    [1, 1, 1, 1, 1, 1],
  ],
};

/*
 * Compact bitmaps for narrow terminals — 5 rows × 4 cols per letter.
 * Also features rounded corners where possible.
 * Compact grid: 9 letters × 4 cols + 8 gaps × 1 col = 44 total columns.
 */
const BITMAPS_COMPACT: Record<string, number[][]> = {
  A: [[0, 1, 1, 0], [1, 0, 0, 1], [1, 1, 1, 1], [1, 0, 0, 1], [1, 0, 0, 1]],
  G: [[0, 1, 1, 0], [1, 0, 0, 0], [1, 0, 1, 1], [1, 0, 0, 1], [0, 1, 1, 0]],
  E: [[1, 1, 1, 1], [1, 0, 0, 0], [1, 1, 1, 0], [1, 0, 0, 0], [1, 1, 1, 1]],
  N: [[1, 0, 0, 1], [1, 1, 0, 1], [1, 0, 1, 1], [1, 0, 0, 1], [1, 0, 0, 1]],
  C: [[0, 1, 1, 0], [1, 0, 0, 1], [1, 0, 0, 0], [1, 0, 0, 1], [0, 1, 1, 0]],
  Y: [[1, 0, 0, 1], [0, 1, 1, 0], [0, 1, 1, 0], [0, 1, 1, 0], [0, 1, 1, 0]],
  L: [[1, 0, 0, 0], [1, 0, 0, 0], [1, 0, 0, 0], [1, 0, 0, 0], [1, 1, 1, 1]],
  I: [[1, 1, 1, 1], [0, 1, 1, 0], [0, 1, 1, 0], [0, 1, 1, 0], [1, 1, 1, 1]],
};

const WORD = "AGENCYCLI";
const GAP = 1;

/* Curated neon color palette keys for the gradient marquee */
const PALETTE: (keyof ThemeTokens)[] = [
  "accent",    // Purple / Blue
  "success",   // Neon Green
  "warning",   // Bright Gold
  "danger",    // Hot Red / Pink
  "highlight", // Deep Violet
];

/** Build a pixel grid from bitmap definitions. */
function buildGrid(
  bitmaps: Record<string, number[][]>,
  rows: number,
  letterW: number,
  gap: number,
): boolean[][] {
  const grid: boolean[][] = Array.from({ length: rows }, () => []);
  for (let i = 0; i < WORD.length; i++) {
    const bm = bitmaps[WORD[i]!]!;
    if (i > 0) {
      for (let r = 0; r < rows; r++) {
        for (let g = 0; g < gap; g++) grid[r]!.push(false);
      }
    }
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < letterW; c++) {
        grid[r]!.push(bm[r]![c]! === 1);
      }
    }
  }
  return grid;
}

/* ── Pre-compute both grid variants at module load ── */

const FULL_ROWS = 7;
const FULL_LETTER_W = 6;
const FULL_GRID = buildGrid(BITMAPS_FULL, FULL_ROWS, FULL_LETTER_W, GAP);
const FULL_TOTAL_COLS = FULL_GRID[0]!.length;    // 62
const FULL_SLOT = FULL_LETTER_W + GAP;            // 7

const COMPACT_ROWS = 5;
const COMPACT_LETTER_W = 4;
const COMPACT_GRID = buildGrid(BITMAPS_COMPACT, COMPACT_ROWS, COMPACT_LETTER_W, GAP);
const COMPACT_TOTAL_COLS = COMPACT_GRID[0]!.length; // 44
const COMPACT_SLOT = COMPACT_LETTER_W + GAP;        // 5

/**
 * Animated pixel-art logo for AGENCYCLI.
 *
 * Multi-layered neon animation with responsive sizing:
 * ┌─────────────────────────────────────────────────────────┐
 * │ Full mode:  7×6 rounded bitmaps (62 cols, ≥64 width)   │
 * │ Compact:    5×4 bitmaps (44 cols, <64 width)           │
 * ├─────────────────────────────────────────────────────────┤
 * │ Layer 1: Per-Letter Solid Gradient Marquee              │
 * │   Each letter rendered in a single uniform color that   │
 * │   smoothly cycles through a curated neon palette.       │
 * │   Letters always maintain perfect shape coherence.      │
 * │                                                         │
 * │ Layer 2: Horizontal Scanner Beam                        │
 * │   A sharp white highlight glides across all rows,       │
 * │   creating a holographic scan effect.                   │
 * │                                                         │
 * │ Layer 3: Micro-Sparkle                                  │
 * │   Rare, subtle white glints on individual pixels        │
 * │   for holographic depth.                                │
 * └─────────────────────────────────────────────────────────┘
 */
export function GlowingLogo({
  theme,
  tick: externalTick,
  maxWidth: _maxWidth,
  animated = true,
  height,
}: GlowingLogoProps) {
  const motion = animated && animationsEnabled();
  const localTick = useTick(motion, 50);
  const tick = externalTick !== undefined ? externalTick : motion ? localTick : 0;

  const { cols, rows: layoutRows } = useTerminalLayout();
  const rows = height ?? layoutRows;
  const shouldCollapse = rows < 20 || cols < 50;

  if (shouldCollapse) {
    return (
      <Box flexDirection="column" alignItems="center" flexShrink={0}>
        <Text color={theme.accent} bold>
          ▲ AGENCYCLI
        </Text>
      </Box>
    );
  }

  // ── Responsive grid selection ──
  const useCompact = cols < 72 || rows < 26;
  const grid = useCompact ? COMPACT_GRID : FULL_GRID;
  const totalCols = useCompact ? COMPACT_TOTAL_COLS : FULL_TOTAL_COLS;
  const slot = useCompact ? COMPACT_SLOT : FULL_SLOT;

  // Color cycle offset — rotates every 12 ticks (600ms at 50ms/tick)
  const cycleOffset = Math.floor(tick / 12);

  // Scanner beam position — glides left-to-right then wraps with breathing room
  const beamPos = (tick * 1.2) % (totalCols + 18);

  return (
    <Box flexDirection="column" alignItems="center">
      {grid.map((row, ri) => {
        const runs: { text: string; color?: string; bold?: boolean }[] = [];
        let currentRun: { text: string; color?: string; bold?: boolean } | null = null;

        for (let ci = 0; ci < row.length; ci++) {
          const on = row[ci];
          if (!on) {
            if (currentRun && currentRun.color === undefined && currentRun.bold === undefined) {
              currentRun.text += " ";
            } else {
              if (currentRun) runs.push(currentRun);
              currentRun = { text: " " };
            }
          } else {
            const letterIdx = Math.floor(ci / slot);
            const paletteIdx = (letterIdx + cycleOffset) % PALETTE.length;
            let color = theme[PALETTE[paletteIdx]!] as string;
            let bold = false;

            const distToBeam = Math.abs(ci - beamPos);
            if (distToBeam < 1.5) {
              color = theme.text;
              bold = true;
            } else if (distToBeam < 3.5) {
              bold = true;
            }

            const sparkleHash = (tick * 23 + ci * 41 + ri * 59) % 400;
            if (sparkleHash === 0) {
              color = theme.text;
              bold = true;
            }

            if (currentRun && currentRun.color === color && currentRun.bold === bold) {
              currentRun.text += "█";
            } else {
              if (currentRun) runs.push(currentRun);
              currentRun = { text: "█", color, bold };
            }
          }
        }
        if (currentRun) runs.push(currentRun);

        return (
          <Box key={ri} flexDirection="row">
            {runs.map((run, runIdx) => (
              <Text key={runIdx} color={run.color} bold={run.bold}>
                {run.text}
              </Text>
            ))}
          </Box>
        );
      })}
    </Box>
  );
}
