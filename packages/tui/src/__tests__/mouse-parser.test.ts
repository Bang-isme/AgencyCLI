import { describe, it, expect } from "vitest";
import { parseMouseEvents, isMouseResidue } from "../terminal/mouse.js";

const ESC = "\x1b";

describe("parseMouseEvents (SGR)", () => {
  it("parses a left button press and release", () => {
    expect(parseMouseEvents(`${ESC}[<0;10;5M`)).toEqual([
      { type: "down", x: 10, y: 5, button: 0, raw: 0 },
    ]);
    expect(parseMouseEvents(`${ESC}[<0;10;5m`)).toEqual([
      { type: "up", x: 10, y: 5, button: 0, raw: 0 },
    ]);
  });

  it("distinguishes middle/right buttons by the low two bits", () => {
    expect(parseMouseEvents(`${ESC}[<1;2;3M`)[0]).toMatchObject({ type: "down", button: 1 });
    expect(parseMouseEvents(`${ESC}[<2;2;3M`)[0]).toMatchObject({ type: "down", button: 2 });
  });

  it("treats the drag/motion bit (32) as a move", () => {
    // 32 = left button held + motion
    expect(parseMouseEvents(`${ESC}[<32;7;8M`)[0]).toMatchObject({ type: "move", x: 7, y: 8 });
  });

  it("maps wheel codes 64/65 to wheel-up/down", () => {
    expect(parseMouseEvents(`${ESC}[<64;1;1M`)[0]).toMatchObject({ type: "wheel-up" });
    expect(parseMouseEvents(`${ESC}[<65;1;1M`)[0]).toMatchObject({ type: "wheel-down" });
  });

  it("parses several events in one chunk (a fast drag)", () => {
    const chunk = `${ESC}[<32;5;5M${ESC}[<32;6;6M${ESC}[<0;6;6m`;
    const evs = parseMouseEvents(chunk);
    expect(evs.map((e) => e.type)).toEqual(["move", "move", "up"]);
    expect(evs[1]).toMatchObject({ x: 6, y: 6 });
  });

  it("ignores non-mouse input and malformed fragments", () => {
    expect(parseMouseEvents("hello world")).toEqual([]);
    expect(parseMouseEvents("")).toEqual([]);
    expect(parseMouseEvents(`${ESC}[<0;10M`)).toEqual([]); // missing a field
  });

  it("extracts the event from a chunk that also carries plain text", () => {
    const evs = parseMouseEvents(`abc${ESC}[<0;3;4Mdef`);
    expect(evs).toHaveLength(1);
    expect(evs[0]).toMatchObject({ type: "down", x: 3, y: 4 });
  });
});

describe("isMouseResidue (composer guard)", () => {
  it("matches mouse SGR residue with or without the leading ESC", () => {
    expect(isMouseResidue("[<0;10;5M")).toBe(true);
    expect(isMouseResidue(`${ESC}[<65;1;1M`)).toBe(true);
  });

  it("never matches legitimate typing", () => {
    expect(isMouseResidue("")).toBe(false);
    expect(isMouseResidue("hello")).toBe(false);
    expect(isMouseResidue("a[b]c")).toBe(false);
    expect(isMouseResidue("< 3 ;")).toBe(false);
  });
});
