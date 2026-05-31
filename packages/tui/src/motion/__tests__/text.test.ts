import { describe, expect, it } from "vitest";
import {
  frameAt,
  routingPhase,
  shimmerIndex,
  typewriterVisible,
} from "../text.js";

describe("motion text", () => {
  it("cycles spinner frames", () => {
    expect(frameAt(["a", "b", "c"], 0)).toBe("a");
    expect(frameAt(["a", "b", "c"], 4)).toBe("b");
  });

  it("reveals typewriter text progressively", () => {
    expect(typewriterVisible("hello", 0, 2)).toBe("");
    expect(typewriterVisible("hello", 1, 2)).toBe("he");
    expect(typewriterVisible("hello", 10, 2)).toBe("hello");
  });

  it("computes shimmer highlight index", () => {
    expect(shimmerIndex(5, 0)).toBe(0);
    expect(shimmerIndex(5, 3)).toBe(3);
    expect(shimmerIndex(5, 7)).toBe(2);
  });

  it("rotates routing phase labels", () => {
    expect(routingPhase(0)).toContain("Routing");
    expect(routingPhase(3)).not.toBe(routingPhase(0));
  });
});
