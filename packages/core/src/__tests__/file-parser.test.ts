import { describe, expect, it } from "vitest";
import { applySearchReplace } from "../utils/file-parser.js";

describe("applySearchReplace", () => {
  it("does a normal literal replace (fast path)", () => {
    expect(applySearchReplace("const x = 42;\nconst y = 1;", "const x = 42;", "const x = 9;"))
      .toBe("const x = 9;\nconst y = 1;");
  });

  it("inserts the replacement literally — no $$/$&/$`/$' expansion (fast path)", () => {
    // Replacement contains every String.replace special sequence; a string
    // replacement would expand them and corrupt the file.
    const replace = "total = $$ + $& + a$`b + $'end";
    expect(applySearchReplace("const price = OLD;", "OLD", replace))
      .toBe("const price = " + replace + ";");
  });

  it("the line-based fallback also inserts literally", () => {
    // Trailing whitespace makes the exact-substring fast path miss, so the
    // trimEnd line matcher (which concatenates) runs — already literal.
    const replace = "X $& $$ Y";
    expect(applySearchReplace("a  \nb", "a\nb", replace)).toBe(replace);
  });
});
