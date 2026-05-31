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
    // If it's a paste, we might have \r\n sequences. Let's normalize \r\n to \n first.
    const normalizedInput = input.replace(/\r\n/g, "\n");
    for (let i = 0; i < normalizedInput.length; i++) {
      const char = normalizedInput[i];
      const isCharBackspace =
        char === "\b" ||
        char === "\x08" ||
        char === "\x7f";

      if (isCharBackspace) {
        setter((b) => deleteLastGrapheme(b));
      } else {
        const code = char.charCodeAt(0);
        const isAllowedControl = code === 9 || code === 10 || code === 13;
        const cleaned = isAllowedControl
          ? (char === "\r" ? "\n" : char)
          : char.replace(/[\x00-\x1F\x7F-\x9F\u200B-\u200F\uFEFF]/g, "");
        if (cleaned) {
          setter((b) => b + cleaned);
        }
      }
    }
    return true;
  }

  return false;
}

