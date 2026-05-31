import { describe, expect, it } from "vitest";
import { gradientTextColor, lerpHex } from "../gradient.js";

describe("gradient", () => {
  it("lerps between two hex colors", () => {
    expect(lerpHex("#000000", "#ffffff", 0)).toBe("#000000");
    expect(lerpHex("#000000", "#ffffff", 1)).toBe("#ffffff");
    const mid = lerpHex("#000000", "#ffffff", 0.5);
    expect(mid).toMatch(/^#[0-9a-f]{6}$/i);
  });

  it("returns accent-like color near wave peak", () => {
    const muted = "#71717a";
    const accent = "#a78bfa";
    const atPeak = gradientTextColor(5, 20, 5, muted, accent);
    const far = gradientTextColor(0, 20, 0, muted, accent);
    expect(atPeak).not.toBe(far);
  });
});
