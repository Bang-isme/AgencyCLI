/** RGB gradient helpers for Ink text (true-color hex). */

function parseHex(hex: string): { r: number; g: number; b: number } | null {
  const m = hex.trim().match(/^#?([0-9a-f]{6})$/i);
  if (!m) return null;
  const n = parseInt(m[1]!, 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

function toHex(r: number, g: number, b: number): string {
  const clamp = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
  return `#${[clamp(r), clamp(g), clamp(b)]
    .map((c) => c.toString(16).padStart(2, "0"))
    .join("")}`;
}

export function lerpHex(from: string, to: string, t: number): string {
  const a = parseHex(from);
  const b = parseHex(to);
  if (!a || !b) return to;
  const u = Math.max(0, Math.min(1, t));
  return toHex(
    a.r + (b.r - a.r) * u,
    a.g + (b.g - a.g) * u,
    a.b + (b.b - a.b) * u
  );
}

/** Animated gradient color for character at index (shimmer wave). */
export function gradientTextColor(
  index: number,
  length: number,
  tick: number,
  muted: string,
  accent: string
): string {
  const span = Math.max(length, 1) + 12;
  const pos = (index + tick * 2) % span;
  const wave = 1 - Math.abs(pos / span - 0.5) * 2;
  const t = Math.pow(Math.max(0, wave), 1.6);
  return lerpHex(muted, accent, t);
}
