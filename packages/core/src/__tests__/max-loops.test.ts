import { describe, it, expect, afterEach } from "vitest";
import { defaultMaxLoops, resolveMaxLoops } from "../chat/turn-helpers.js";

describe("resolveMaxLoops (deduped iteration cap + AGENCY_MAX_LOOPS override)", () => {
  const prev = process.env.AGENCY_MAX_LOOPS;
  afterEach(() => {
    if (prev === undefined) delete process.env.AGENCY_MAX_LOOPS;
    else process.env.AGENCY_MAX_LOOPS = prev;
  });

  it("defaultMaxLoops: deep=15, normal=8, fast/other=3 (unchanged constants)", () => {
    expect(defaultMaxLoops("deep")).toBe(15);
    expect(defaultMaxLoops("normal")).toBe(8);
    expect(defaultMaxLoops("fast")).toBe(3);
    expect(defaultMaxLoops("whatever")).toBe(3);
  });

  it("env unset + no explicit → the per-budget default (byte-identical)", () => {
    delete process.env.AGENCY_MAX_LOOPS;
    expect(resolveMaxLoops("deep")).toBe(15);
    expect(resolveMaxLoops("normal")).toBe(8);
    expect(resolveMaxLoops("fast")).toBe(3);
  });

  it("an explicit cap (e.g. a subagent's own) wins over both env and default", () => {
    process.env.AGENCY_MAX_LOOPS = "99";
    expect(resolveMaxLoops("deep", 7)).toBe(7);
  });

  it("AGENCY_MAX_LOOPS (positive int) raises the cap when no explicit cap is given", () => {
    process.env.AGENCY_MAX_LOOPS = "30";
    expect(resolveMaxLoops("deep")).toBe(30);
    expect(resolveMaxLoops("fast")).toBe(30);
  });

  it("floors a fractional override and ignores invalid / non-positive values", () => {
    process.env.AGENCY_MAX_LOOPS = "25.9";
    expect(resolveMaxLoops("deep")).toBe(25);
    process.env.AGENCY_MAX_LOOPS = "0";
    expect(resolveMaxLoops("deep")).toBe(15);
    process.env.AGENCY_MAX_LOOPS = "-5";
    expect(resolveMaxLoops("deep")).toBe(15);
    process.env.AGENCY_MAX_LOOPS = "abc";
    expect(resolveMaxLoops("deep")).toBe(15);
  });
});
