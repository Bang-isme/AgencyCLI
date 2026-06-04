import { describe, it, expect, afterEach } from "vitest";
import { render } from "ink-testing-library";
import { BlinkCursor, cursorBlinkOn } from "../components/AnimatedText.js";

const BLOCK = "▌";

describe("BlinkCursor (composer caret blink)", () => {
  const savedAnim = process.env.AGENCY_TUI_ANIMATIONS;
  afterEach(() => {
    if (savedAnim === undefined) delete process.env.AGENCY_TUI_ANIMATIONS;
    else process.env.AGENCY_TUI_ANIMATIONS = savedAnim;
  });

  // The block's visibility is `cursorBlinkOn(tick)` where `tick` comes from the
  // shared frame clock via useTick(530ms). This pure cadence is the real blink
  // contract — the clock advancing the tick is exercised by the frame-clock's
  // own tests, so locking the cadence here is the faithful, non-flaky guard.
  it("cadence: even ticks show the block, odd ticks hide it", () => {
    expect(cursorBlinkOn(0)).toBe(true);
    expect(cursorBlinkOn(1)).toBe(false);
    expect(cursorBlinkOn(2)).toBe(true);
    expect(cursorBlinkOn(3)).toBe(false);
  });

  it("inactive: renders no block (a space placeholder)", () => {
    process.env.AGENCY_TUI_ANIMATIONS = "0";
    const { lastFrame } = render(<BlinkCursor active={false} />);
    expect(lastFrame() ?? "").not.toContain(BLOCK);
  });

  it("animations off: the block stays solid (no regression vs the static cursor)", () => {
    // useTick is a constant 0 when animations are disabled → cursorBlinkOn(0) →
    // always-visible block, byte-identical to the previous static cursor.
    process.env.AGENCY_TUI_ANIMATIONS = "0";
    const { lastFrame } = render(<BlinkCursor active />);
    expect(lastFrame() ?? "").toContain(BLOCK);
  });
});
