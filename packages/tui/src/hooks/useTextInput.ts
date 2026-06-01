import { deleteLastGrapheme } from "../utils/text.js";

/**
 * Shared text input handler for buffer-style editing.
 * Call this from your existing useInput handler for character input.
 * Handles: backspace, delete, Ctrl+H, IME chunks, control shortcuts.
 * Returns true if the input was consumed (no further processing needed).
 */
export function applyTextInput(
  input: string,
  key: any,
  setter: (fn: (b: string) => string) => void
): boolean {
  if (key.return && input.length === 1) return false;

  if (input.includes("\x1b")) return false;

  const isCtrlH = key.ctrl && (input === "h" || key.name === "h");
  const isBackspaceOrDelete = key.backspace || key.delete || isCtrlH;

  if (isBackspaceOrDelete) {
    setter((b) => deleteLastGrapheme(b));
    return true;
  }

  const isControlShortcut =
    (key.ctrl || key.meta) &&
    (!input ||
      (/^[a-zA-Z]$/.test(input) && input !== "h") ||
      (input.length > 0 &&
        input.charCodeAt(0) < 32 &&
        input.charCodeAt(0) !== 8 &&
        input.charCodeAt(0) !== 9 &&
        input.charCodeAt(0) !== 10 &&
        input.charCodeAt(0) !== 13 &&
        input.charCodeAt(0) !== 127));

  if (isControlShortcut || key.escape) {
    return false;
  }

  if (input) {
    // Ink delivers a whole paste as ONE multi-character `input` (per its docs),
    // so we must process the run in a SINGLE state update. The old code called
    // `setter(b => b + char)` once per character \u2014 O(n\u00B2) string rebuilds that
    // froze the UI on a large paste (the \u00A78.5 jank). Accumulate the cleaned text
    // locally and apply it once; left-to-right semantics are preserved because
    // an embedded backspace pops the local accumulator first and only "overflows"
    // onto the existing buffer when the accumulator is empty (matching the old
    // per-char delete order exactly).
    const normalizedInput = input.replace(/\r\n/g, "\n");
    let appended = "";
    let bufferDeletes = 0;
    for (let i = 0; i < normalizedInput.length; i++) {
      const char = normalizedInput[i]!;
      if (char === "\b" || char === "\x08" || char === "\x7f") {
        if (appended.length > 0) {
          appended = deleteLastGrapheme(appended);
        } else {
          bufferDeletes++;
        }
        continue;
      }
      const code = char.charCodeAt(0);
      const isAllowedControl = code === 9 || code === 10 || code === 13;
      const cleaned = isAllowedControl
        ? (char === "\r" ? "\n" : char)
        : char.replace(/[\x00-\x1F\x7F-\x9F\u200B-\u200F\uFEFF]/g, "");
      appended += cleaned;
    }

    if (bufferDeletes === 0 && appended === "") return true;

    setter((b) => {
      let next = b;
      for (let d = 0; d < bufferDeletes; d++) next = deleteLastGrapheme(next);
      return next + appended;
    });
    return true;
  }

  return false;
}

