/**
 * AgencyCLI motion identity — the single source of truth for every animated
 * surface in the TUI.
 *
 * Design stance: a *calm intelligent execution runtime*, not a flashy hacker
 * terminal. Every primitive here is intentionally restrained, single-cell, and
 * ConPTY / Windows-Terminal safe. Generic clichés (braille "dots" spinners,
 * Matrix rain, DNA helixes) are deliberately absent — the vocabulary below is
 * what makes an AgencyCLI screen recognizable at a glance.
 *
 * Rule: nothing in this file is dead. If a primitive stops being consumed it is
 * removed, not parked — so the identity stays small and every screen breathes
 * from the same handful of helpers.
 */

/* ── Loading Spinner ── */

/**
 * Agency signature loading spinner — a single luminous arc that orbits the
 * cell clockwise. Deliberately chosen over the ubiquitous braille "dots"
 * spinner (ora / cli-spinners) so an Agency loading state is recognizable at a
 * glance, while staying single-width and ConPTY / Windows-Terminal safe.
 *
 * This is THE canonical spinner: every animated surface reads from it (one
 * source of truth), so the whole UI breathes in sync. The historical
 * `SPINNER_DOTS` / `SPINNER_FRAMES` names alias it — never redefine them.
 */
export const AGENCY_SPINNER = ["◜", "◠", "◝", "◞", "◡", "◟"] as const;

/**
 * @deprecated Use {@link AGENCY_SPINNER}. Aliased to the canonical spinner so
 * existing imports keep animating from a single source.
 */
export const SPINNER_DOTS = AGENCY_SPINNER;

/** Heavier block-braille pulse — the primary tool-activity "wave" indicator. */
export const SPINNER_BLOCKS = ["⣾", "⣽", "⣻", "⢿", "⡿", "⣟", "⣯", "⣷"] as const;

/* ── Scanning Line ── */

/** A "scanning" highlight that moves across a width (ping-pong). */
export function scanPosition(width: number, tick: number, speed = 1): number {
  const cycle = width * 2;
  const pos = (tick * speed) % cycle;
  return pos < width ? pos : cycle - pos - 1;
}

/* ── Pulse Dots ── */

const PULSE_FRAMES = [
  "   ",
  "·  ",
  "·· ",
  "···",
  " ··",
  "  ·",
  "   ",
] as const;

export function pulseDots(tick: number): string {
  return PULSE_FRAMES[tick % PULSE_FRAMES.length]!;
}

/* ── Energy Bar ── */

const ENERGY_CHARS = ["░", "▒", "▓", "█", "▓", "▒", "░"] as const;

export function energyBar(width: number, tick: number): string {
  const chars: string[] = [];
  for (let i = 0; i < width; i++) {
    const idx = (i + tick) % ENERGY_CHARS.length;
    chars.push(ENERGY_CHARS[idx]!);
  }
  return chars.join("");
}

/* ── Gradient Blocks ── */

const GRADIENT = ["░", "▒", "▓", "█"] as const;

/** Returns a gradient character based on position ratio (0..1). */
export function gradientChar(ratio: number): string {
  const clamped = ratio < 0 ? 0 : ratio > 1 ? 1 : ratio;
  const idx = Math.min(GRADIENT.length - 1, Math.floor(clamped * GRADIENT.length));
  return GRADIENT[idx]!;
}

/**
 * Canonical "scan" progress bar — a bright head (with a softened gradient tail)
 * gliding across a dim track. Single source of truth for indeterminate progress
 * so every panel's scanning animation looks identical.
 */
export function scanBar(width: number, tick: number, headWidth = 3): string {
  const head = scanPosition(width, tick);
  const chars: string[] = [];
  for (let i = 0; i < width; i++) {
    const dist = Math.abs(i - head);
    if (dist === 0) chars.push("█");
    else if (dist < headWidth) chars.push(gradientChar(1 - dist / headWidth));
    else chars.push("░");
  }
  return chars.join("");
}

/* ── Lifecycle Markers ── */

/**
 * Agency lifecycle markers — one geometric "diamond" family read as a
 * progression (hollow ◇ → facet ◈ → filled ◆). Distinct from the generic ○/✓
 * vocabulary and the single source of truth for step / agent state icons, so
 * every panel stays visually consistent. `✕` is the lifecycle's terminal
 * (errored) facet; result/severity semantics live in {@link SEVERITY_GLYPHS}.
 */
export const LIFECYCLE_GLYPHS = {
  pending: "◇",
  active: "◈",
  done: "◆",
  error: "✕",
} as const;

/* ── Severity Markers ── */

/**
 * Agency severity vocabulary — the single source of truth for log / event /
 * result icons. One glyph per severity, all single-cell and free of emoji
 * variation-selectors (so `▲` over `⚠`, which renders double-width on many
 * Windows terminals). Keep this distinct from {@link LIFECYCLE_GLYPHS}:
 * lifecycle = "where is this step in its life", severity = "how did it land".
 */
export const SEVERITY_GLYPHS = {
  info: "·",
  debug: "◦",
  adaptation: "→",
  warning: "▲",
  error: "✗",
  critical: "✕",
} as const;

/* ── Decorative Dividers ── */

export function accentDivider(width: number, tick: number): string {
  const scanPos = scanPosition(width, tick, 2);
  const chars: string[] = [];
  for (let i = 0; i < width; i++) {
    const dist = Math.abs(i - scanPos);
    if (dist === 0) chars.push("◆");
    else if (dist === 1) chars.push("◇");
    else if (dist === 2) chars.push("·");
    else chars.push("─");
  }
  return chars.join("");
}
