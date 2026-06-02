import { describe, it, expect } from "vitest";
import {
  type EditBuffer,
  clampCursor,
  moveLeft,
  moveRight,
  moveStart,
  moveEnd,
  moveWordLeft,
  moveWordRight,
  insert,
  backspace,
  deleteForward,
  deleteWordBackward,
  editFromInput,
  emptyHistory,
  recordEdit,
  undo,
  redo,
  MAX_HISTORY,
} from "../utils/text-buffer.js";

const b = (text: string, cursor: number): EditBuffer => ({ text, cursor });

describe("text-buffer — navigation", () => {
  it("clampCursor bounds and rejects NaN/negative", () => {
    expect(clampCursor("hello", -3)).toBe(0);
    expect(clampCursor("hello", NaN)).toBe(0);
    expect(clampCursor("hello", 99)).toBe(5);
    expect(clampCursor("hello", 2)).toBe(2);
  });

  it("moveLeft/moveRight step one grapheme and clamp at the ends", () => {
    expect(moveLeft(b("abc", 2)).cursor).toBe(1);
    expect(moveLeft(b("abc", 0)).cursor).toBe(0);
    expect(moveRight(b("abc", 1)).cursor).toBe(2);
    expect(moveRight(b("abc", 3)).cursor).toBe(3);
  });

  it("moveLeft/moveRight step over a surrogate pair as one unit", () => {
    const emoji = "a😀b"; // 😀 is 2 UTF-16 code units (indices 1..3)
    expect(moveRight(b(emoji, 1)).cursor).toBe(3); // skip the whole emoji
    expect(moveLeft(b(emoji, 3)).cursor).toBe(1);
  });

  it("moveStart/moveEnd jump to the buffer edges", () => {
    expect(moveStart(b("hello", 3)).cursor).toBe(0);
    expect(moveEnd(b("hello", 1)).cursor).toBe(5);
  });

  it("word navigation jumps over whitespace-delimited runs", () => {
    const t = "foo  bar baz";
    expect(moveWordLeft(b(t, 12)).cursor).toBe(9); // start of "baz"
    expect(moveWordLeft(b(t, 9)).cursor).toBe(5); // start of "bar"
    expect(moveWordRight(b(t, 0)).cursor).toBe(3); // end of "foo"
    expect(moveWordRight(b(t, 3)).cursor).toBe(8); // end of "bar"
  });
});

describe("text-buffer — mutation at the caret", () => {
  it("insert places text at the caret and advances it", () => {
    expect(insert(b("ac", 1), "b")).toEqual({ text: "abc", cursor: 2 });
    expect(insert(b("", 0), "hi")).toEqual({ text: "hi", cursor: 2 });
  });

  it("backspace deletes the grapheme before the caret, not the end", () => {
    expect(backspace(b("abc", 2))).toEqual({ text: "ac", cursor: 1 });
    expect(backspace(b("abc", 0))).toEqual({ text: "abc", cursor: 0 });
  });

  it("backspace removes a whole surrogate pair", () => {
    expect(backspace(b("a😀", 3))).toEqual({ text: "a", cursor: 1 });
  });

  it("deleteForward removes the grapheme at the caret", () => {
    expect(deleteForward(b("abc", 1))).toEqual({ text: "ac", cursor: 1 });
    expect(deleteForward(b("abc", 3))).toEqual({ text: "abc", cursor: 3 });
  });

  it("deleteWordBackward removes from the previous word start to the caret", () => {
    expect(deleteWordBackward(b("foo bar", 7))).toEqual({ text: "foo ", cursor: 4 });
    expect(deleteWordBackward(b("foo bar", 0))).toEqual({ text: "foo bar", cursor: 0 });
  });
});

describe("text-buffer — editFromInput keystroke translation", () => {
  it("inserts a typed character at the caret", () => {
    const r = editFromInput("x", {}, b("ab", 1));
    expect(r).not.toBeNull();
    expect(r!.buffer).toEqual({ text: "axb", cursor: 2 });
    expect(r!.kind).toBe("insert");
    expect(r!.boundary).toBe(false);
  });

  it("applies a multi-character paste in one update and flags a boundary", () => {
    const r = editFromInput("hello world", {}, b("", 0));
    expect(r!.buffer).toEqual({ text: "hello world", cursor: 11 });
    expect(r!.boundary).toBe(true); // paste starts its own undo group
  });

  it("normalizes CRLF inside a paste", () => {
    const r = editFromInput("a\r\nb", {}, b("", 0));
    expect(r!.buffer.text).toBe("a\nb");
  });

  it("strips disallowed control chars but keeps tab/newline", () => {
    const r = editFromInput("a\x07b\tc", {}, b("", 0));
    expect(r!.buffer.text).toBe("ab\tc");
  });

  it("backspace key deletes before the caret", () => {
    const r = editFromInput("", { backspace: true }, b("abc", 2));
    expect(r!.buffer).toEqual({ text: "ac", cursor: 1 });
    expect(r!.kind).toBe("delete");
  });

  it("delete key deletes forward at the caret", () => {
    const r = editFromInput("", { delete: true }, b("abc", 1));
    expect(r!.buffer).toEqual({ text: "ac", cursor: 1 });
  });

  it("an embedded backspace in a run pops the accumulator then the buffer", () => {
    // "x" inserted, then DEL removes it, then "y" → net "y" at caret over "AB|"
    const r = editFromInput("x\x7fy", {}, b("AB", 2));
    expect(r!.buffer.text).toBe("ABy");
  });

  it("returns null for a bare Return (submit), escape sequences, and control shortcuts", () => {
    expect(editFromInput("\n", { return: true }, b("hi", 2))).toBeNull();
    expect(editFromInput("\x1b[D", {}, b("hi", 2))).toBeNull(); // left-arrow seq
    expect(editFromInput("z", { ctrl: true }, b("hi", 2))).toBeNull(); // Ctrl+Z
    expect(editFromInput("", { escape: true }, b("hi", 2))).toBeNull();
  });

  it("a whitespace keystroke flags an undo boundary", () => {
    const r = editFromInput(" ", {}, b("hi", 2));
    expect(r!.boundary).toBe(true);
  });
});

describe("text-buffer — undo/redo history", () => {
  it("coalesces a run of single-char inserts into one undo step", () => {
    let hist = emptyHistory();
    // type "abc" one char at a time, recording the pre-state each time
    hist = recordEdit(hist, b("", 0), "insert", false);
    hist = recordEdit(hist, b("a", 1), "insert", false);
    hist = recordEdit(hist, b("ab", 2), "insert", false);
    // coalesced: only the first pre-state ("") is retained
    expect(hist.past).toEqual([{ text: "", cursor: 0 }]);
    const u = undo(hist, b("abc", 3));
    expect(u!.buffer).toEqual({ text: "", cursor: 0 });
  });

  it("a boundary edit starts a fresh undo group", () => {
    let hist = emptyHistory();
    hist = recordEdit(hist, b("", 0), "insert", false);
    hist = recordEdit(hist, b("a", 1), "insert", true); // boundary (e.g. paste)
    expect(hist.past).toEqual([{ text: "", cursor: 0 }, { text: "a", cursor: 1 }]);
  });

  it("undo then redo round-trips, and a new edit clears the redo stack", () => {
    let hist = emptyHistory();
    hist = recordEdit(hist, b("", 0), "insert", true);
    const cur = b("a", 1);
    const u = undo(hist, cur)!;
    expect(u.buffer).toEqual({ text: "", cursor: 0 });
    const r = redo(u.hist, u.buffer)!;
    expect(r.buffer).toEqual({ text: "a", cursor: 1 });
    // a new edit after undo drops the redo future
    const u2 = undo(hist, cur)!;
    const after = recordEdit(u2.hist, b("", 0), "insert", true);
    expect(after.future).toEqual([]);
  });

  it("undo/redo return null when the respective stack is empty", () => {
    expect(undo(emptyHistory(), b("a", 1))).toBeNull();
    expect(redo(emptyHistory(), b("a", 1))).toBeNull();
  });

  it("caps the undo depth at MAX_HISTORY", () => {
    let hist = emptyHistory();
    for (let i = 0; i < MAX_HISTORY + 50; i++) {
      hist = recordEdit(hist, b("x".repeat(i), i), "insert", true);
    }
    expect(hist.past.length).toBe(MAX_HISTORY);
  });
});
