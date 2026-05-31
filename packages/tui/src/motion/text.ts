// Re-exported from the design system so there is exactly one spinner
// definition in the codebase (no duplicated glyph arrays to drift apart).
export { AGENCY_SPINNER as SPINNER_FRAMES } from "./design-system.js";

export const ROUTING_PHASES = [
  "Routing prompt",
  "Matching skills",
  "Building context",
  "Waiting for model",
] as const;

export function frameAt(frames: readonly string[], tick: number): string {
  if (frames.length === 0) return "";
  return frames[((tick % frames.length) + frames.length) % frames.length]!;
}

export function typewriterVisible(
  text: string,
  tick: number,
  charsPerTick = 2
): string {
  const len = Math.min(text.length, tick * charsPerTick);
  return text.slice(0, len);
}

export function shimmerIndex(length: number, tick: number): number {
  if (length <= 0) return 0;
  return ((tick % length) + length) % length;
}

export function routingPhase(tick: number): string {
  return ROUTING_PHASES[
    ((tick % ROUTING_PHASES.length) + ROUTING_PHASES.length) %
      ROUTING_PHASES.length
  ]!;
}
