import { describe, expect, it } from "vitest";
import {
  borderCharCount,
  composerInnerWidth,
  composerWidth,
  contentWidth,
  dividerRepeat,
  layoutWidth,
  measureTerminal,
  panelWidth,
  scrollbarMargin,
  truncateText,
} from "../terminal-layout.js";

describe("terminal-layout", () => {
  it("uses adaptive scrollbar margin by terminal width", () => {
    expect(scrollbarMargin(60)).toBe(1);
    expect(scrollbarMargin(80)).toBe(1);
    expect(scrollbarMargin(120)).toBe(1);
    expect(scrollbarMargin(200)).toBe(1);
  });

  it("measures consistent shell and content widths", () => {
    expect(measureTerminal(80)).toEqual({
      cols: 80,
      rows: 24,
      shellWidth: 78,
      contentWidth: 78,
      composerWidth: 78,
      composerInnerWidth: 74,
      shellHeight: 23,
    });
    expect(measureTerminal(120)).toMatchObject({
      cols: 120,
      shellWidth: 118,
      contentWidth: 118,
      composerWidth: 118,
      composerInnerWidth: 114,
    });
  });

  it("never returns zero or negative widths", () => {
    expect(layoutWidth(1)).toBeGreaterThan(0);
    expect(contentWidth(1)).toBeGreaterThan(0);
  });

  it("matches divider length to box width", () => {
    const width = layoutWidth(120);
    expect(dividerRepeat(width)).toHaveLength(width);
  });

  it("keeps composer panel inside content bounds", () => {
    for (const cols of [60, 80, 120, 200]) {
      const layout = measureTerminal(cols);
      expect(layout.composerWidth).toBeLessThanOrEqual(layout.contentWidth);
      expect(layout.composerInnerWidth).toBeLessThan(layout.composerWidth);
      expect(composerWidth(cols)).toBe(composerInnerWidth(cols) + 4);
    }
  });

  it("keeps border text inside inner width", () => {
    const inner = contentWidth(120);
    const borderLen = 2 + borderCharCount(inner) + 1;
    expect(borderLen).toBe(inner);
  });

  it("caps panel width responsively", () => {
    expect(panelWidth(60)).toBe(58);
    expect(panelWidth(80)).toBe(78);
    expect(panelWidth(200)).toBe(96);
  });

  it("truncates long strings", () => {
    expect(truncateText("hello world", 8)).toBe("hello w…");
  });
});
