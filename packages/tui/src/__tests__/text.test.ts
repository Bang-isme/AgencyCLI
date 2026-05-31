import { describe, expect, it } from "vitest";
import { deleteLastGrapheme, getCharWidth, getStringWidth, truncateText, formatTokenCount, formatCount } from "../utils/text.js";

describe("formatTokenCount", () => {
  it("keeps small counts as a bare integer", () => {
    expect(formatTokenCount(0)).toBe("0");
    expect(formatTokenCount(742)).toBe("742");
  });

  it("uses a compact k/M suffix above 1000 (never a locale separator)", () => {
    expect(formatTokenCount(4109)).toBe("4.1k");
    expect(formatTokenCount(1159)).toBe("1.2k");
    expect(formatTokenCount(1_500_000)).toBe("1.5M");
    // Regression: must NOT render the host-locale "4.109" thousands form.
    expect(formatTokenCount(4109)).not.toContain(".109");
  });
});

describe("formatCount", () => {
  it("always uses an ASCII comma thousands separator", () => {
    expect(formatCount(4109)).toBe("4,109");
    expect(formatCount(42)).toBe("42");
  });
});

describe("deleteLastGrapheme", () => {
  it("deletes a single normal character", () => {
    expect(deleteLastGrapheme("hello")).toBe("hell");
  });

  it("handles empty string", () => {
    expect(deleteLastGrapheme("")).toBe("");
  });

  it("deletes precomposed Vietnamese characters", () => {
    expect(deleteLastGrapheme("tiếng")).toBe("tiến");
    expect(deleteLastGrapheme("viết")).toBe("viế");
  });

  it("deletes decomposed Vietnamese characters", () => {
    // 'ế' decomposed is 'e' + '\u0302' (circumflex) + '\u0301' (acute)
    const decomposedEe = "e\u0302\u0301";
    expect(deleteLastGrapheme(decomposedEe)).toBe("");
    expect(deleteLastGrapheme("tie\u0302\u0301ng")).toBe("tie\u0302\u0301n");
  });

  it("deletes emojis correctly", () => {
    expect(deleteLastGrapheme("hello👋")).toBe("hello");
    expect(deleteLastGrapheme("👋")).toBe("");
  });
});

describe("visual width utilities", () => {
  it("getCharWidth handles combining characters", () => {
    // Circumflex '\u0302' is a combining mark -> width 0
    expect(getCharWidth("\u0302")).toBe(0);
    // Acute accent '\u0301' is a combining mark -> width 0
    expect(getCharWidth("\u0301")).toBe(0);
    // Normal character -> width 1
    expect(getCharWidth("e")).toBe(1);
    // Fullwidth CJK -> width 2
    expect(getCharWidth("繁")).toBe(2);
    // Emoji -> width 2
    expect(getCharWidth("👋")).toBe(2);
  });

  it("getStringWidth handles decomposed/precomposed Vietnamese and mixed characters", () => {
    const precomposed = "tiếng"; // length 5, visual width 5
    const decomposed = "tie\u0302\u0301ng"; // length 7, visual width 5
    expect(getStringWidth(precomposed)).toBe(5);
    expect(getStringWidth(decomposed)).toBe(5);

    const withEmoji = "xin chào 👋"; // "xin chào " (9 cols) + "👋" (2 cols) = 11 cols
    expect(getStringWidth(withEmoji)).toBe(11);
  });

  it("truncateText truncates correctly by visual width", () => {
    const decomposed = "tie\u0302\u0301ng vi\u0302\u0301t"; // "tiếng viết", visual width 10
    // Truncating to 5 cols: should show "tiến…" (visual width 5, since "ế" is decomposed and is kept together)
    expect(truncateText(decomposed, 5)).toBe("tie\u0302\u0301n…");
    
    // Truncating to 11 cols (wider than string): should return unchanged
    expect(truncateText(decomposed, 12)).toBe(decomposed);
  });
});

import { wrapText, parseInlineSpans, wrapStyledSpans, combineAdjacentSpans } from "../utils/text.js";

describe("wrapText with preserveIndent", () => {
  it("preserves leading spaces on wrapped lines", () => {
    const text = "    const x = 5;";
    // wrap width 8. Indent is 4 spaces. Remaining width for content is Math.max(4, 8-4) = 4.
    // "const" (width 5) -> force wraps to "cons", "t".
    // "x" -> "x ".
    // "=" -> "= ".
    // "5;" -> "5;".
    // Final result should have "    " prefixed on all wrapped lines.
    const wrapped = wrapText(text, 8, { preserveIndent: true });
    expect(wrapped).toEqual([
      "    cons",
      "    t x ",
      "    = 5;"
    ]);
  });

  it("handles empty lines and whitespace-only lines without crashing", () => {
    expect(wrapText("", 10, { preserveIndent: true })).toEqual([""]);
    expect(wrapText("   ", 10, { preserveIndent: true })).toEqual(["   "]);
  });
});

describe("styled span wrapping utilities", () => {
  it("parseInlineSpans parses bold and code sections correctly", () => {
    const text = "This is **bold** and `code` sections.";
    const parsed = parseInlineSpans(text);
    expect(parsed).toEqual([
      { text: "This is " },
      { text: "bold", isBold: true },
      { text: " and " },
      { text: "code", isCode: true },
      { text: " sections." }
    ]);
  });

  it("wrapStyledSpans wraps and preserves styles on wrapped lines", () => {
    const spans = [
      { text: "This is a " },
      { text: "very long bold phrase", isBold: true }
    ];
    // wrap width 12
    const lines = wrapStyledSpans(spans, 12);
    // Combine adjacent spans on each line to check result
    const combined = lines.map(combineAdjacentSpans);
    
    expect(combined[0]).toEqual([
      { text: "This is a " }
    ]);
    expect(combined[1]).toEqual([
      { text: "very long ", isBold: true }
    ]);
    expect(combined[2]).toEqual([
      { text: "bold phrase", isBold: true }
    ]);
  });
});

import { extractPathCandidates } from "../utils/text.js";

describe("extractPathCandidates", () => {
  it("extracts clean and quoted paths correctly", () => {
    const text = "Please read \"src/App.tsx\" and check 'd:/My Documents/notes.txt' or look at @utils/text.ts, and also check out package.json.";
    const candidates = extractPathCandidates(text);
    expect(candidates).toEqual([
      "src/App.tsx",
      "d:/My Documents/notes.txt",
      "@utils/text.ts",
      "package.json"
    ]);
  });

  it("handles empty or plain text without paths", () => {
    expect(extractPathCandidates("")).toEqual([]);
    expect(extractPathCandidates("hello world how are you")).toEqual([]);
  });

  it("ignores slash commands but preserves actual root-level Unix paths", () => {
    expect(extractPathCandidates("/viewstatus")).toEqual([]);
    expect(extractPathCandidates("/help")).toEqual([]);
    expect(extractPathCandidates("/etc/hosts")).toEqual(["/etc/hosts"]);
  });
});

import { estimateComposerHeight } from "../App.js";

describe("estimateComposerHeight", () => {
  it("calculates height correctly for placeholders", () => {
    // Empty buffer + not loading => hintsHeight (1) + 3 = 4
    expect(estimateComposerHeight("", 80, false)).toBe(4);
    // Empty buffer + loading => hintsHeight (0) + 3 = 3
    expect(estimateComposerHeight("", 80, true)).toBe(3);
  });

  it("calculates height for multiline inputs with wrapping", () => {
    // Normal small text => 1 content line + 2 borders = 3
    expect(estimateComposerHeight("hello", 80, false)).toBe(3);

    // Multiline split => 3 lines + 2 borders = 5
    expect(estimateComposerHeight("line1\nline2\nline3", 80, false)).toBe(5);
  });

  it("adds height for attached path candidates", () => {
    // Text + 1 candidate path => 1 content line + 2 borders + 1 attachments row = 4
    expect(estimateComposerHeight("check src/App.tsx", 80, false)).toBe(4);
  });
});




