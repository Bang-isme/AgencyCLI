import { describe, expect, it } from "vitest";
import { completeAtRef, getAtQuery } from "../at/utils.js";

describe("at utils", () => {
  it("detects active @ query", () => {
    expect(getAtQuery("how @src/auth"))?.toEqual({
      query: "src/auth",
      start: 4,
    });
    expect(getAtQuery("done @file.ts ok")).toBeNull();
  });

  it("completeAtRef replaces partial query", () => {
    expect(completeAtRef("see @src", "src/auth.ts")).toBe(
      "see @src/auth.ts "
    );
  });
});
