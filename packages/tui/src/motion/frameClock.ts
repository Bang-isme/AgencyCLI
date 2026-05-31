/**
 * Unified adaptive frame clock for the TUI.
 *
 * Historically every animated component owned its own `setInterval`. With a
 * spinner, shimmer, wave and typewriter on screen at once, that meant N
 * uncoordinated OS timers, each firing its own `setState` on a different phase
 * boundary — wasted wakeups plus visible cross-component tearing.
 *
 * This module collapses all animation into a single self-scheduling timer.
 * Components register the cadence they want (their `intervalMs`); the clock
 * keeps one counter per distinct cadence and advances each counter on its own
 * boundary while only ever holding one live timer. The wake-up interval tracks
 * the fastest active cadence, and the lag multiplier is re-evaluated on every
 * wake-up (not just once at mount) so the whole UI gracefully slows down — in
 * lockstep — when the event loop is under pressure.
 */
import { getLoopLag, getTuiPhase } from "../terminal/screen.js";

const now = (): number =>
  typeof performance !== "undefined" ? performance.now() : Date.now();

interface Bucket {
  /** Requested cadence in ms (the multiplier is applied on top of this). */
  readonly interval: number;
  /** Monotonic frame counter handed back to subscribers. */
  tick: number;
  /** Timestamp of the last advance. */
  lastAdvance: number;
  readonly subscribers: Set<() => void>;
}

const buckets = new Map<number, Bucket>();
let timer: ReturnType<typeof setTimeout> | null = null;

/**
 * Slow the whole animation system in lockstep when the event loop is lagging.
 * Pure so it can be unit-tested without real timers. Only the steady-state
 * "main" phase is throttled — splash/welcome run at full rate for a crisp boot.
 */
export function frameMultiplier(lag: number, phase: string): number {
  if (phase !== "main") return 1;
  if (lag > 200) return 10;
  if (lag > 100) return 4;
  if (lag > 50) return 2;
  return 1;
}

function currentMultiplier(): number {
  return frameMultiplier(getLoopLag(), getTuiPhase());
}

function hasSubscribers(): boolean {
  for (const b of buckets.values()) {
    if (b.subscribers.size > 0) return true;
  }
  return false;
}

function scheduleNext(): void {
  const mult = currentMultiplier();
  let nextWake = Infinity;
  for (const b of buckets.values()) {
    if (b.subscribers.size === 0) continue;
    nextWake = Math.min(nextWake, b.interval * mult);
  }
  if (nextWake === Infinity) {
    timer = null;
    return;
  }
  timer = setTimeout(onWake, nextWake);
  // Never keep the process alive purely for animation frames.
  (timer as { unref?: () => void }).unref?.();
}

function advanceBuckets(t: number, mult: number): void {
  for (const b of buckets.values()) {
    if (b.subscribers.size === 0) continue;
    // -1ms slack absorbs timer jitter so a cadence never silently skips a frame.
    if (t - b.lastAdvance >= b.interval * mult - 1) {
      b.tick++;
      b.lastAdvance = t;
      for (const cb of b.subscribers) cb();
    }
  }
}

function onWake(): void {
  advanceBuckets(now(), currentMultiplier());
  scheduleNext();
}

/**
 * Subscribe to a cadence. `onFrame` fires when that cadence advances; read the
 * latest value with {@link getFrame}. Returns an unsubscribe function.
 */
export function subscribeFrame(intervalMs: number, onFrame: () => void): () => void {
  const key = Math.max(1, Math.round(intervalMs));
  let bucket = buckets.get(key);
  if (!bucket) {
    bucket = { interval: key, tick: 0, lastAdvance: now(), subscribers: new Set() };
    buckets.set(key, bucket);
  }
  bucket.subscribers.add(onFrame);

  if (timer === null) scheduleNext();

  return () => {
    bucket!.subscribers.delete(onFrame);
    // Keep the (now idle) bucket so its tick stays continuous across remounts;
    // it costs nothing and is skipped while it has no subscribers. When the
    // last cadence goes idle, let the in-flight timer expire and not reschedule.
    if (!hasSubscribers() && timer) {
      clearTimeout(timer);
      timer = null;
    }
  };
}

/** Current frame counter for a cadence (0 if never registered). */
export function getFrame(intervalMs: number): number {
  return buckets.get(Math.max(1, Math.round(intervalMs)))?.tick ?? 0;
}

/** Test-only: reset all clock state. */
export function __resetFrameClock(): void {
  if (timer) clearTimeout(timer);
  timer = null;
  buckets.clear();
}

/** Test-only: deterministically advance the clock as if `elapsed` ms passed. */
export function __tickFrameClock(elapsed: number, mult = 1): void {
  const t = now();
  for (const b of buckets.values()) {
    b.lastAdvance = t - elapsed;
  }
  advanceBuckets(t, mult);
}
