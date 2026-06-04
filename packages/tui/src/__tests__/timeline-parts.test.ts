import { describe, it, expect } from "vitest";
import { parseConversationParts } from "../utils/conversation/timeline-parts.js";

describe("parseConversationParts (ordered timeline categorizer)", () => {
  it("preserves true interleave order: text → activity → text → activity", () => {
    const content = [
      "Let me start.",
      '⚡ [SYSTEM: Executing tool "write_file" on src/a.ts...]',
      "Now the next file.",
      '⚡ [SYSTEM: Executing tool "write_file" on src/b.ts...]',
      "Done.",
    ].join("\n");
    const parts = parseConversationParts(content);
    expect(parts.map((p) => p.kind)).toEqual(["text", "activity", "text", "activity", "text"]);
    expect(parts[0]).toMatchObject({ kind: "text", lines: ["Let me start."] });
    expect(parts[4]).toMatchObject({ kind: "text", lines: ["Done."] });
  });

  it("coalesces consecutive activity lines into ONE ordered activity part", () => {
    const content = [
      "Working:",
      '⚡ [SYSTEM: Executing tool "write_file" on a.ts...]',
      '⚡ [SYSTEM: Tool "write_file" completed: 1.2 KB]',
      '⚡ [SYSTEM: Executing tool "write_file" on b.ts...]',
    ].join("\n");
    const parts = parseConversationParts(content);
    expect(parts.map((p) => p.kind)).toEqual(["text", "activity"]);
    expect(parts[1]!.lines).toHaveLength(3);
  });

  it("treats a verbose [SYSTEM:] notice as activity (so it can render concise, not verbatim text)", () => {
    const content = [
      "Some prose.",
      '⚠ [SYSTEM: Reached the maximum 15 tool/continuation iterations for this turn — the work may be incomplete.]',
    ].join("\n");
    const parts = parseConversationParts(content);
    expect(parts.map((p) => p.kind)).toEqual(["text", "activity"]);
  });

  it("captures fenced code as its own ordered part with language, between text", () => {
    const content = ["Here is code:", "```ts", "const x = 1;", "const y = 2;", "```", "After."].join("\n");
    const parts = parseConversationParts(content);
    expect(parts.map((p) => p.kind)).toEqual(["text", "code", "text"]);
    const code = parts[1] as Extract<ReturnType<typeof parseConversationParts>[number], { kind: "code" }>;
    expect(code.language).toBe("ts");
    expect(code.lines).toEqual(["const x = 1;", "const y = 2;"]);
  });

  it("drops blank-only text parts and trims surrounding blank lines", () => {
    const content = ["", "  ", "Real text.", "", '⚡ [SYSTEM: Executing tool "read_file" on x.ts...]', "", ""].join("\n");
    const parts = parseConversationParts(content);
    expect(parts.map((p) => p.kind)).toEqual(["text", "activity"]);
    expect(parts[0]).toMatchObject({ kind: "text", lines: ["Real text."] });
  });

  it("collapses an interior run of blank lines to a single blank line", () => {
    // The shape `stripToolCalls` leaves behind: prose, then the joined newlines
    // of a removed tool-call block, then more prose — one text part with a
    // multi-blank hole in the middle.
    const content = ["Before the tool.", "", "", "", "After the tool."].join("\n");
    const parts = parseConversationParts(content);
    expect(parts.map((p) => p.kind)).toEqual(["text"]);
    expect(parts[0]).toMatchObject({
      kind: "text",
      lines: ["Before the tool.", "", "After the tool."],
    });
  });

  it("flushes an unterminated (mid-stream) code fence", () => {
    const content = ["Writing:", "```js", "const a = 1;"].join("\n");
    const parts = parseConversationParts(content);
    expect(parts.map((p) => p.kind)).toEqual(["text", "code"]);
    const code = parts[1] as Extract<ReturnType<typeof parseConversationParts>[number], { kind: "code" }>;
    expect(code.lines).toEqual(["const a = 1;"]);
  });

  it("returns [] for empty / non-string content", () => {
    expect(parseConversationParts("")).toEqual([]);
    expect(parseConversationParts(undefined as unknown as string)).toEqual([]);
  });
});
