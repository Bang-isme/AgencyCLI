import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { animationsEnabled } from "../motion/animations.js";

describe("animationsEnabled", () => {
  const prev = process.env.AGENCY_TUI_ANIMATIONS;

  beforeEach(() => {
    delete process.env.AGENCY_TUI_ANIMATIONS;
  });

  afterEach(() => {
    if (prev === undefined) delete process.env.AGENCY_TUI_ANIMATIONS;
    else process.env.AGENCY_TUI_ANIMATIONS = prev;
  });

  it("defaults to enabled", () => {
    expect(animationsEnabled()).toBe(true);
  });

  it("disables on 0", () => {
    process.env.AGENCY_TUI_ANIMATIONS = "0";
    expect(animationsEnabled()).toBe(false);
  });

  it("disables on false", () => {
    process.env.AGENCY_TUI_ANIMATIONS = "false";
    expect(animationsEnabled()).toBe(false);
  });
});
