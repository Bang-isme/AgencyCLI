import { describe, expect, it } from "vitest";
import {
  AGENCY_SPINNER,
  LIFECYCLE_GLYPHS,
  SEVERITY_GLYPHS,
  SPINNER_DOTS,
  energyBar,
  scanBar,
  gradientChar,
} from "../design-system.js";
import { SPINNER_FRAMES } from "../text.js";

describe("Agency motion identity", () => {
  it("uses the signature arc spinner, not the generic braille dots", () => {
    expect([...AGENCY_SPINNER]).toEqual(["◜", "◠", "◝", "◞", "◡", "◟"]);
    // The ubiquitous ora / cli-spinners braille set must not be the spinner.
    expect(AGENCY_SPINNER).not.toContain("⠋");
  });

  it("exposes the spinner from a single source of truth", () => {
    // Both historical names must alias the one canonical array — no drift.
    expect(SPINNER_DOTS).toBe(AGENCY_SPINNER);
    expect(SPINNER_FRAMES).toBe(AGENCY_SPINNER);
  });

  it("defines a cohesive diamond lifecycle family", () => {
    expect(LIFECYCLE_GLYPHS).toEqual({
      pending: "◇",
      active: "◈",
      done: "◆",
      error: "✕",
    });
    // Each marker is a single visible cell (no accidental width surprises).
    for (const glyph of Object.values(LIFECYCLE_GLYPHS)) {
      expect([...glyph]).toHaveLength(1);
    }
  });

  it("defines a severity vocabulary distinct from the lifecycle family", () => {
    expect(SEVERITY_GLYPHS).toEqual({
      info: "·",
      debug: "◦",
      adaptation: "→",
      warning: "▲",
      error: "✗",
      critical: "✕",
    });
    // ConPTY / Windows safety: every severity glyph is a single cell and free of
    // emoji variation-selectors that render double-width (so "▲" over "⚠").
    for (const glyph of Object.values(SEVERITY_GLYPHS)) {
      expect([...glyph]).toHaveLength(1);
      expect(glyph).not.toBe("⚠");
    }
  });
});

describe("indeterminate progress primitives", () => {
  it("scanBar fills exactly the requested width with a single bright head", () => {
    const bar = scanBar(20, 5);
    expect([...bar]).toHaveLength(20);
    expect(bar).toContain("█");
  });

  it("energyBar fills exactly the requested width", () => {
    expect([...energyBar(12, 3)]).toHaveLength(12);
  });

  it("gradientChar clamps out-of-range ratios", () => {
    expect(gradientChar(-5)).toBe("░");
    expect(gradientChar(5)).toBe("█");
  });
});
