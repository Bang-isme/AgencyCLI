/**
 * Terminal mouse layer (flag `mouseSupport` / `AGENCY_MOUSE`).
 *
 * Historically the TUI ran with mouse tracking OFF and let `?1007h` translate
 * the wheel into ↑/↓ arrows. With full SGR tracking on that translation stops,
 * so this module OWNS the wheel and parses click/drag/move/wheel events from
 * stdin, dispatching them to subscribers. It is intentionally *additive*: it
 * never touches the keyboard/render path and swallows every parse error, so the
 * worst case is "clicks do nothing", never a broken TUI.
 *
 * Mode BYTES are written by `terminal/screen.ts` (the single mode-control site);
 * this module owns the stdin listener, the pure parser, and the subscribe API.
 */
import { getRuntimeFlags } from "@agency/core";

/** Whether the mouse layer is active for this process. */
export function mouseEnabled(): boolean {
  try {
    return getRuntimeFlags().mouseSupport;
  } catch {
    return false;
  }
}

/**
 * SGR mouse mode enable/disable sequences. `?1000h` = button press/release,
 * `?1002h` = button-drag motion (needed to grab/drag the scrollbar), `?1006h` =
 * extended SGR coordinates (so columns/rows aren't capped at 223). When these
 * are on we deliberately do NOT set `?1007h` — we translate the wheel ourselves.
 */
export const MOUSE_ENABLE_SEQ = "\x1b[?1000h\x1b[?1002h\x1b[?1006h";
export const MOUSE_DISABLE_SEQ = "\x1b[?1000l\x1b[?1002l\x1b[?1006l";

export type MouseEventType =
  | "down"
  | "up"
  | "move"
  | "wheel-up"
  | "wheel-down";

export interface TuiMouseEvent {
  type: MouseEventType;
  /** 1-based terminal column. */
  x: number;
  /** 1-based terminal row. */
  y: number;
  /** 0 = left, 1 = middle, 2 = right (for down/up/drag); low bits otherwise. */
  button: number;
  /** Raw SGR button code (Cb) — exposes modifier/drag bits for advanced uses. */
  raw: number;
}

// ESC [ < Cb ; Cx ; Cy (M|m). `M` = press/motion/wheel, `m` = button release.
const SGR_RE = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g;

/**
 * Parse every SGR mouse event in a raw stdin chunk. Pure — a chunk may carry
 * several events (e.g. a fast drag) or none; malformed fragments are skipped.
 */
export function parseMouseEvents(buf: string): TuiMouseEvent[] {
  const out: TuiMouseEvent[] = [];
  if (!buf || buf.indexOf("\x1b[<") === -1) return out;
  SGR_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = SGR_RE.exec(buf)) !== null) {
    const cb = Number.parseInt(m[1]!, 10);
    const x = Number.parseInt(m[2]!, 10);
    const y = Number.parseInt(m[3]!, 10);
    const suffix = m[4]!;
    if (!Number.isFinite(cb) || !Number.isFinite(x) || !Number.isFinite(y)) continue;
    let type: MouseEventType;
    if (cb & 64) {
      // Wheel: low bit 0 = up (64), 1 = down (65).
      type = cb & 1 ? "wheel-down" : "wheel-up";
    } else if (cb & 32) {
      type = "move";
    } else {
      type = suffix === "M" ? "down" : "up";
    }
    out.push({ type, x, y, button: cb & 3, raw: cb });
  }
  return out;
}

/**
 * True when `input` (as delivered to the keyboard handler) is the residue of a
 * mouse SGR sequence that also reached Ink's input parser. The keyboard handler
 * drops these so a click can never inject junk into the composer. The pattern is
 * mouse-specific, so it can never match legitimate typing.
 */
const RESIDUE_RE = /\[<\d+;\d+;\d+[Mm]/;
export function isMouseResidue(input: string): boolean {
  return !!input && RESIDUE_RE.test(input);
}

type Listener = (ev: TuiMouseEvent) => void;
const listeners = new Set<Listener>();

/** Subscribe to mouse events. Returns an unsubscribe function. */
export function subscribeMouse(fn: Listener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

function dispatch(buf: string): void {
  if (listeners.size === 0) return;
  const events = parseMouseEvents(buf);
  for (const ev of events) {
    for (const fn of listeners) {
      try {
        fn(ev);
      } catch {
        // A subscriber must never break the input stream.
      }
    }
  }
}

let onData: ((chunk: Buffer | string) => void) | null = null;

/**
 * Attach the stdin listener that feeds {@link subscribeMouse}. Idempotent. Mode
 * bytes are written separately by `screen.ts`. The listener is a no-op unless a
 * chunk actually contains a mouse sequence, so it never interferes with typing.
 */
export function attachMouseListener(): void {
  if (onData) return;
  const handler = (chunk: Buffer | string): void => {
    try {
      const s = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      if (s.indexOf("\x1b[<") !== -1) dispatch(s);
    } catch {
      // Never throw from the input path.
    }
  };
  onData = handler;
  try {
    process.stdin.on("data", handler);
  } catch {
    onData = null;
  }
}

/** Detach the stdin listener (called on teardown). Idempotent. */
export function detachMouseListener(): void {
  if (!onData) return;
  try {
    process.stdin.off("data", onData);
  } catch {
    // best-effort
  }
  onData = null;
}
