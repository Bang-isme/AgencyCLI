import { describe, it, expect } from "vitest";
import { applyTextInput } from "../hooks/useTextInput.js";

/** Drive applyTextInput with a string buffer, tracking setter-call count. */
function run(input: string, key: Record<string, unknown> = {}, initial = "") {
  let buf = initial;
  let calls = 0;
  const setter = (fn: (b: string) => string) => {
    calls++;
    buf = fn(buf);
  };
  const consumed = applyTextInput(input, key, setter);
  return { buf, consumed, calls };
}

describe("applyTextInput (§8.5 — paste handling)", () => {
  it("applies a large paste in a SINGLE state update (no O(n²) per-char churn)", () => {
    const paste = "a".repeat(5000);
    const { buf, consumed, calls } = run(paste);
    expect(consumed).toBe(true);
    expect(buf).toBe(paste);
    expect(calls).toBe(1); // the perf fix: one setter call, not 5000
  });

  it("normalizes \\r\\n to \\n in a pasted block", () => {
    const { buf } = run("line1\r\nline2\r\nline3");
    expect(buf).toBe("line1\nline2\nline3");
  });

  it("keeps allowed controls (tab/newline) and strips other control chars", () => {
    const { buf, calls } = run("a\x07b\tc\nd"); // \x07 BEL stripped, \t and \n kept
    expect(buf).toBe("ab\tc\nd");
    expect(calls).toBe(1);
  });

  it("preserves left-to-right semantics for an embedded backspace mid-run", () => {
    // "ab" then DEL then "c" → "ac", appended onto the existing buffer.
    const { buf } = run("ab\x7fc", {}, "XY");
    expect(buf).toBe("XYac");
  });

  it("an embedded backspace with an empty accumulator deletes from the existing buffer", () => {
    const { buf } = run("\x7fa", {}, "XY");
    expect(buf).toBe("Xa");
  });

  it("does not consume a bare Return (lets the submit handler see it)", () => {
    const { consumed, calls } = run("\n", { return: true });
    expect(consumed).toBe(false);
    expect(calls).toBe(0);
  });

  it("ignores raw escape sequences (e.g. arrow keys)", () => {
    const { consumed, calls } = run("\x1b[A");
    expect(consumed).toBe(false);
    expect(calls).toBe(0);
  });

  it("deletes a grapheme on backspace key", () => {
    const { buf } = run("", { backspace: true }, "héllo");
    expect(buf).toBe("héll");
  });
});
