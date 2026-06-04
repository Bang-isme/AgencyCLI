import { describe, expect, it } from "vitest";
import { resolveThoughtExpansion } from "../components/Conversation.js";

/**
 * The live-detail / idle-digest behaviour: the model's thought block expands WHILE
 * a message is streaming (so you watch it think) and collapses the instant the
 * stream ends (so a finished transcript stays compact), independent of the manual
 * `ctrl+o` pin. Pure decision — `Conversation` reads the flag once per render and
 * feeds it here at each thought site.
 */
describe("resolveThoughtExpansion", () => {
  it("manual ctrl+o pins the LAST message's thought open (even when idle)", () => {
    expect(resolveThoughtExpansion(true, true, false, false)).toBe(true);
  });

  it("manual ctrl+o does not expand non-last messages", () => {
    expect(resolveThoughtExpansion(true, false, false, false)).toBe(false);
  });

  it("auto-expands while streaming when the flag is on (any message)", () => {
    expect(resolveThoughtExpansion(false, false, true, true)).toBe(true);
  });

  it("COLLAPSES the moment the stream ends (the core ask)", () => {
    // streaming flips true → false → thought auto-collapses with the flag on.
    expect(resolveThoughtExpansion(false, false, true, true)).toBe(true);
    expect(resolveThoughtExpansion(false, false, false, true)).toBe(false);
  });

  it("is a no-op when the flag is off (legacy: manual-expand only)", () => {
    expect(resolveThoughtExpansion(false, false, true, false)).toBe(false);
    expect(resolveThoughtExpansion(false, true, true, false)).toBe(false);
  });

  it("either trigger alone expands (OR semantics)", () => {
    expect(resolveThoughtExpansion(true, true, false, false)).toBe(true); // manual only
    expect(resolveThoughtExpansion(false, false, true, true)).toBe(true); // auto only
    expect(resolveThoughtExpansion(false, false, false, false)).toBe(false); // neither
  });
});
