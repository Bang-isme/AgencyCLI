import { useEffect, useRef } from "react";
import { Text } from "ink";
import type { ThemeTokens } from "../themes/registry.js";
import { frameAt, SPINNER_FRAMES, typewriterVisible } from "../motion/text.js";
import { useTick } from "../motion/useTick.js";

export interface ShimmerTextProps {
  text: string;
  theme: ThemeTokens;
  bold?: boolean;
  active?: boolean;
}

/** Single sliding accent — avoids full-string gradient redraw flicker. */
export function ShimmerText({
  text,
  theme,
  bold = false,
  active = true,
}: ShimmerTextProps) {
  const tick = useTick(active, 120);
  const base = bold ? theme.text : theme.muted;
  if (!active || text.length === 0) {
    return (
      <Text bold={bold} color={base}>
        {text}
      </Text>
    );
  }

  const chars = Array.from(text);
  const hi = tick % Math.max(chars.length, 1);
  return (
    <Text bold={bold}>
      {chars.map((ch, i) => (
        <Text key={`${i}-${ch}`} color={i === hi ? theme.accent : base}>
          {ch}
        </Text>
      ))}
    </Text>
  );
}

export interface TypewriterTextProps {
  text: string;
  color: string;
  active?: boolean;
  charsPerTick?: number;
  showCursor?: boolean;
  onComplete?: () => void;
}

export function TypewriterText({
  text,
  color,
  active = true,
  charsPerTick = 3,
  showCursor = true,
  onComplete,
}: TypewriterTextProps) {
  const tick = useTick(active && text.length > 0, 45);
  const visible = typewriterVisible(text, tick, charsPerTick);
  const done = visible.length >= text.length;
  const completed = useRef(false);

  useEffect(() => {
    if (done && onComplete && !completed.current) {
      completed.current = true;
      onComplete();
    }
  }, [done, onComplete]);

  return (
    <Text color={color}>
      {visible}
      {showCursor && active && !done ? (
        <Text color={color}>▌</Text>
      ) : null}
    </Text>
  );
}

export interface SpinnerTextProps {
  label: string;
  theme: ThemeTokens;
  active?: boolean;
}

export function SpinnerText({ label, theme, active = true }: SpinnerTextProps) {
  const tick = useTick(active, 100);
  const spin = frameAt(SPINNER_FRAMES, tick);

  return (
    <Text color={theme.muted}>
      <Text color={theme.accent}>{spin} </Text>
      {label}
    </Text>
  );
}

export interface BlinkCursorProps {
  active?: boolean;
}

/** Conventional terminal cursor blink half-period (ms): ~530ms on, ~530ms off. */
const CURSOR_BLINK_MS = 530;

/**
 * Block-cursor visibility for a given blink tick — even ticks show the block.
 * Pure so the cadence is unit-testable without driving the frame clock.
 */
export function cursorBlinkOn(tick: number): boolean {
  return tick % 2 === 0;
}

/**
 * Input cursor — blinks by toggling the block's *visibility* on the shared frame
 * clock, NOT the ANSI blink attribute (\x1b[5m) which glitches on Windows
 * Terminal. The off-frame renders a single space so the caret column never
 * shifts width. When animations are disabled (AGENCY_TUI_ANIMATIONS=0 /
 * reduced-motion / non-TTY) {@link useTick} is a constant 0, so the block stays
 * solid — byte-identical to the previous static cursor.
 */
export function BlinkCursor({ active = true }: BlinkCursorProps) {
  const tick = useTick(active, CURSOR_BLINK_MS);
  if (!active) return <Text> </Text>;
  return <Text>{cursorBlinkOn(tick) ? "▌" : " "}</Text>;
}

export interface WaveTextProps {
  text: string;
  theme: ThemeTokens;
  active?: boolean;
}

/** Color wave that flows across text characters — 3-char highlight window */
export function WaveText({ text, theme, active = true }: WaveTextProps) {
  const tick = useTick(active, 100);
  if (!active || text.length === 0) {
    return <Text color={theme.muted}>{text}</Text>;
  }

  const chars = Array.from(text);
  const center = tick % (chars.length + 4);
  return (
    <Text>
      {chars.map((ch, i) => {
        const dist = Math.abs(i - center);
        let color = theme.muted;
        if (dist === 0) color = theme.accent;
        else if (dist === 1) color = theme.text;
        else if (dist === 2) color = theme.muted;
        return (
          <Text key={`${i}-${ch}`} color={color}>
            {ch}
          </Text>
        );
      })}
    </Text>
  );
}
