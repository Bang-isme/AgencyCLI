import { describe, it, expect } from "vitest";
import { scrollbarMetrics } from "../state/scrollbar.js";

describe("scrollbarMetrics", () => {
  it("fills the whole track when nothing overflows", () => {
    expect(scrollbarMetrics(10, 10, 0)).toEqual({ thumbSize: 10, thumbTop: 0 });
    expect(scrollbarMetrics(5, 10, 0)).toEqual({ thumbSize: 10, thumbTop: 0 });
  });

  it("pins the thumb to the top at offset 0", () => {
    expect(scrollbarMetrics(100, 10, 0)).toEqual({ thumbSize: 1, thumbTop: 0 });
  });

  it("pins the thumb to the bottom at the max offset", () => {
    // maxOffset = total - viewport = 90; thumbSize 1 → maxThumbTop = 9.
    expect(scrollbarMetrics(100, 10, 90)).toEqual({ thumbSize: 1, thumbTop: 9 });
  });

  it("interpolates the thumb in the middle", () => {
    // 45/90 of travel (9) = 4.5 → rounds to 5.
    expect(scrollbarMetrics(100, 10, 45)).toEqual({ thumbSize: 1, thumbTop: 5 });
  });

  it("sizes the thumb proportional to the visible fraction", () => {
    // viewport is half the content → thumb is half the track.
    expect(scrollbarMetrics(20, 10, 0)).toEqual({ thumbSize: 5, thumbTop: 0 });
    expect(scrollbarMetrics(20, 10, 10)).toEqual({ thumbSize: 5, thumbTop: 5 });
  });

  it("keeps a minimum thumb size of 1 for very long transcripts", () => {
    const m = scrollbarMetrics(100000, 10, 0);
    expect(m.thumbSize).toBe(1);
  });

  it("clamps out-of-range offsets to the track", () => {
    expect(scrollbarMetrics(100, 10, 999)).toEqual({ thumbSize: 1, thumbTop: 9 });
    expect(scrollbarMetrics(100, 10, -5)).toEqual({ thumbSize: 1, thumbTop: 0 });
  });

  it("never lets the thumb spill past the track", () => {
    for (let total = 1; total <= 200; total += 7) {
      for (let viewport = 1; viewport <= 40; viewport += 3) {
        for (let offset = -2; offset <= total + 2; offset += 5) {
          const { thumbSize, thumbTop } = scrollbarMetrics(total, viewport, offset);
          const track = Math.max(1, viewport);
          expect(thumbSize).toBeGreaterThanOrEqual(1);
          expect(thumbSize).toBeLessThanOrEqual(track);
          expect(thumbTop).toBeGreaterThanOrEqual(0);
          expect(thumbTop + thumbSize).toBeLessThanOrEqual(track);
        }
      }
    }
  });

  it("handles a 1-row viewport without dividing by zero", () => {
    expect(scrollbarMetrics(100, 1, 0)).toEqual({ thumbSize: 1, thumbTop: 0 });
    expect(scrollbarMetrics(100, 1, 99)).toEqual({ thumbSize: 1, thumbTop: 0 });
  });
});
