/**
 * Pure, cursor-aware text-buffer model for the prompt composer.
 *
 * The legacy composer was append-only: `applyTextInput` only ever appended to
 * the end and deleted the last grapheme, so the caret was pinned to the end of
 * the buffer — you could not move into pasted text to fix it, and there was no
 * undo. This module is the foundation for real editing: an immutable
 * `{ text, cursor }` value plus grapheme-aware navigation, insert/delete at the
 * caret, word operations, and a small undo/redo history.
 *
 * Everything here is a pure function over plain values — no React, no I/O — so
 * the editing semantics can be unit-tested exhaustively and the React layer
 * stays a thin wiring shell.
 */

export interface EditBuffer {
  /** The full buffer text. */
  text: string;
  /** Caret offset as a UTF-16 code-unit index in [0, text.length]. */
  cursor: number;
}

// ── Grapheme boundaries (Unicode-aware; falls back to code points) ───────────

let cachedSegmenter: Intl.Segmenter | null | undefined;
function getSegmenter(): Intl.Segmenter | null {
  if (cachedSegmenter !== undefined) return cachedSegmenter;
  try {
    cachedSegmenter = new Intl.Segmenter();
  } catch {
    cachedSegmenter = null;
  }
  return cachedSegmenter;
}

/**
 * Ascending list of grapheme-cluster start offsets for `text`, always including
 * 0 and `text.length`. Used to step the caret over whole user-perceived
 * characters (surrogate pairs, Vietnamese diacritics, emoji ZWJ sequences)
 * rather than raw code units.
 */
function graphemeBoundaries(text: string): number[] {
  if (!text) return [0];
  const seg = getSegmenter();
  const out: number[] = [0];
  if (seg) {
    try {
      for (const s of seg.segment(text)) {
        if (s.index > 0) out.push(s.index);
      }
      out.push(text.length);
      return out;
    } catch {
      // fall through to code-point stepping
    }
  }
  // Fallback: code-point boundaries (still handles surrogate pairs).
  for (const ch of text) {
    const last = out[out.length - 1]!;
    out.push(last + ch.length);
  }
  // The loop above pushed an extra terminal entry equal to text.length already.
  if (out[out.length - 1] !== text.length) out.push(text.length);
  return out;
}

/** Largest grapheme boundary strictly less than `i` (i.e. the caret one step left). */
export function prevGraphemeBoundary(text: string, i: number): number {
  if (i <= 0) return 0;
  const b = graphemeBoundaries(text);
  let prev = 0;
  for (const x of b) {
    if (x < i) prev = x;
    else break;
  }
  return prev;
}

/** Smallest grapheme boundary strictly greater than `i` (i.e. the caret one step right). */
export function nextGraphemeBoundary(text: string, i: number): number {
  if (i >= text.length) return text.length;
  const b = graphemeBoundaries(text);
  for (const x of b) {
    if (x > i) return x;
  }
  return text.length;
}

// ── Word boundaries (whitespace-delimited runs) ──────────────────────────────

function isSpace(ch: string | undefined): boolean {
  return ch === undefined ? false : /\s/.test(ch);
}

/** Offset of the previous word start: skip whitespace left, then non-whitespace left. */
export function prevWordBoundary(text: string, i: number): number {
  let j = Math.max(0, Math.min(i, text.length));
  while (j > 0 && isSpace(text[j - 1])) j--;
  while (j > 0 && !isSpace(text[j - 1])) j--;
  return j;
}

/** Offset past the next word end: skip whitespace right, then non-whitespace right. */
export function nextWordBoundary(text: string, i: number): number {
  let j = Math.max(0, Math.min(i, text.length));
  while (j < text.length && isSpace(text[j])) j++;
  while (j < text.length && !isSpace(text[j])) j++;
  return j;
}

// ── Cursor clamping ──────────────────────────────────────────────────────────

/** Clamp a caret offset into [0, text.length]. NaN/negative → 0. */
export function clampCursor(text: string, cursor: number): number {
  if (!Number.isFinite(cursor) || cursor < 0) return 0;
  if (cursor > text.length) return text.length;
  return Math.floor(cursor);
}

/** Normalize a buffer (clamp its cursor). */
export function normalize(b: EditBuffer): EditBuffer {
  const cursor = clampCursor(b.text, b.cursor);
  return cursor === b.cursor ? b : { text: b.text, cursor };
}

// ── Navigation (pure; return a new EditBuffer) ───────────────────────────────

export function moveLeft(b: EditBuffer): EditBuffer {
  return { text: b.text, cursor: prevGraphemeBoundary(b.text, b.cursor) };
}
export function moveRight(b: EditBuffer): EditBuffer {
  return { text: b.text, cursor: nextGraphemeBoundary(b.text, b.cursor) };
}
export function moveStart(b: EditBuffer): EditBuffer {
  return { text: b.text, cursor: 0 };
}
export function moveEnd(b: EditBuffer): EditBuffer {
  return { text: b.text, cursor: b.text.length };
}
export function moveWordLeft(b: EditBuffer): EditBuffer {
  return { text: b.text, cursor: prevWordBoundary(b.text, b.cursor) };
}
export function moveWordRight(b: EditBuffer): EditBuffer {
  return { text: b.text, cursor: nextWordBoundary(b.text, b.cursor) };
}

// ── Mutation (pure; return a new EditBuffer) ─────────────────────────────────

/** Insert `str` at the caret; the caret moves to the end of the inserted text. */
export function insert(b: EditBuffer, str: string): EditBuffer {
  if (!str) return b;
  const c = clampCursor(b.text, b.cursor);
  const text = b.text.slice(0, c) + str + b.text.slice(c);
  return { text, cursor: c + str.length };
}

/** Delete the grapheme before the caret (Backspace). */
export function backspace(b: EditBuffer): EditBuffer {
  const c = clampCursor(b.text, b.cursor);
  if (c === 0) return { text: b.text, cursor: 0 };
  const start = prevGraphemeBoundary(b.text, c);
  return { text: b.text.slice(0, start) + b.text.slice(c), cursor: start };
}

/** Delete the grapheme at the caret (forward Delete). */
export function deleteForward(b: EditBuffer): EditBuffer {
  const c = clampCursor(b.text, b.cursor);
  if (c >= b.text.length) return { text: b.text, cursor: c };
  const end = nextGraphemeBoundary(b.text, c);
  return { text: b.text.slice(0, c) + b.text.slice(end), cursor: c };
}

/** Delete from the previous word start to the caret (Ctrl+W). */
export function deleteWordBackward(b: EditBuffer): EditBuffer {
  const c = clampCursor(b.text, b.cursor);
  if (c === 0) return { text: b.text, cursor: 0 };
  const start = prevWordBoundary(b.text, c);
  return { text: b.text.slice(0, start) + b.text.slice(c), cursor: start };
}

// ── Undo / redo history ──────────────────────────────────────────────────────

export type EditKind = "insert" | "delete";

export interface History {
  past: EditBuffer[];
  future: EditBuffer[];
  /** Kind of the last recorded edit, for run coalescing. */
  lastKind: EditKind | null;
}

/** Cap the undo depth so a long session can't grow history unbounded. */
export const MAX_HISTORY = 200;

export function emptyHistory(): History {
  return { past: [], future: [], lastKind: null };
}

/**
 * Record the pre-edit state before a mutation so it can be undone.
 *
 * Consecutive same-kind, non-boundary edits coalesce into a single undo step
 * (so typing a run of characters then pressing undo removes the whole run, like
 * a real editor) — but a paste, a whitespace keystroke, or a change of edit kind
 * starts a fresh undo group. Any edit clears the redo stack.
 */
export function recordEdit(
  hist: History,
  prev: EditBuffer,
  kind: EditKind,
  boundary: boolean,
): History {
  const coalesce =
    !boundary && hist.lastKind === kind && hist.past.length > 0;
  if (coalesce) {
    return { past: hist.past, future: [], lastKind: kind };
  }
  const past = [...hist.past, prev];
  if (past.length > MAX_HISTORY) past.splice(0, past.length - MAX_HISTORY);
  return { past, future: [], lastKind: kind };
}

/** Pop the undo stack; returns the restored buffer + new history, or null if empty. */
export function undo(
  hist: History,
  current: EditBuffer,
): { hist: History; buffer: EditBuffer } | null {
  if (hist.past.length === 0) return null;
  const past = hist.past.slice(0, -1);
  const buffer = hist.past[hist.past.length - 1]!;
  return {
    hist: { past, future: [...hist.future, current], lastKind: null },
    buffer,
  };
}

/** Pop the redo stack; returns the restored buffer + new history, or null if empty. */
export function redo(
  hist: History,
  current: EditBuffer,
): { hist: History; buffer: EditBuffer } | null {
  if (hist.future.length === 0) return null;
  const future = hist.future.slice(0, -1);
  const buffer = hist.future[hist.future.length - 1]!;
  return {
    hist: { past: [...hist.past, current], future, lastKind: null },
    buffer,
  };
}

// ── Keystroke → edit (mirrors applyTextInput cleaning, but caret-aware) ───────

const CONTROL_STRIP = /[\u0000-\u001F\u007F-\u009F\u200B-\u200F\uFEFF]/g;

export interface EditResult {
  buffer: EditBuffer;
  kind: EditKind;
  /** Force a fresh undo group (paste / whitespace) rather than coalescing. */
  boundary: boolean;
}

/**
 * Translate a character/paste/backspace keystroke into a caret-aware edit, or
 * `null` when the input is not a text edit (the caller handles navigation,
 * submit, and control shortcuts).
 *
 * A paste arrives as one multi-character `input` (Ink coalesces it), so the run
 * is applied in a single immutable update — no O(n²) per-character rebuild (the
 * §8.5 perf fix, preserved). An embedded backspace pops the locally accumulated
 * text first and only deletes from the buffer once the accumulator is empty,
 * matching left-to-right typing semantics.
 */
export function editFromInput(
  input: string,
  key: { return?: boolean; backspace?: boolean; delete?: boolean; ctrl?: boolean; meta?: boolean; name?: string; escape?: boolean },
  b: EditBuffer,
): EditResult | null {
  if (key.return && input.length === 1) return null; // submit handled by caller
  if (input.includes("\x1b")) return null; // raw escape sequence (arrows/home/…)

  const isCtrlH = !!key.ctrl && (input === "h" || key.name === "h");
  const isBackspace = !!key.backspace || key.name === "backspace" || input === "\b" || input === "\x08" || input === "\x7f" || !!key.delete || key.name === "delete";
  if (isBackspace || isCtrlH) return { buffer: backspace(b), kind: "delete", boundary: false };

  const isControlShortcut =
    (!!key.ctrl || !!key.meta) &&
    (!input ||
      (/^[a-zA-Z]$/.test(input) && input !== "h") ||
      (input.length > 0 &&
        input.charCodeAt(0) < 32 &&
        input.charCodeAt(0) !== 8 &&
        input.charCodeAt(0) !== 9 &&
        input.charCodeAt(0) !== 10 &&
        input.charCodeAt(0) !== 13 &&
        input.charCodeAt(0) !== 127));
  if (isControlShortcut || key.escape) return null;

  if (!input) return null;

  const normalizedInput = input.replace(/\r\n/g, "\n");
  let appended = "";
  let bufferDeletes = 0;
  for (let i = 0; i < normalizedInput.length; i++) {
    const char = normalizedInput[i]!;
    if (char === "\b" || char === "\x08" || char === "\x7f") {
      if (appended.length > 0) appended = appended.slice(0, -1);
      else bufferDeletes++;
      continue;
    }
    const code = char.charCodeAt(0);
    const isAllowedControl = code === 9 || code === 10 || code === 13;
    appended += isAllowedControl ? (char === "\r" ? "\n" : char) : char.replace(CONTROL_STRIP, "");
  }

  if (bufferDeletes === 0 && appended === "") return null;

  let next = b;
  for (let d = 0; d < bufferDeletes; d++) next = backspace(next);
  next = insert(next, appended);

  if (appended === "") return { buffer: next, kind: "delete", boundary: false };
  // A multi-char paste or any whitespace starts its own undo group.
  const boundary = appended.length > 1 || /\s/.test(appended);
  return { buffer: next, kind: "insert", boundary };
}
