/**
 * Compact, locale-stable token/number formatter for status surfaces.
 *
 * `Number.toLocaleString()` with no locale uses the host locale, so on a
 * Vietnamese/European machine `4109` renders as "4.109" — an ambiguous
 * thousands separator. This always produces ASCII output: a bare integer
 * below 1,000 and a `k` suffix above (e.g. 742 → "742", 4109 → "4.1k",
 * 1_000_000 → "1.0M").
 */
export function formatTokenCount(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "0";
  if (n < 1000) return String(Math.round(n));
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

/** Integer with a stable `,` thousands separator (never the host-locale `.`). */
export function formatCount(n: number): string {
  if (!Number.isFinite(n)) return "0";
  return Math.round(n).toLocaleString("en-US");
}

let cachedSegmenter: Intl.Segmenter | null = null;
function getSegmenter(): Intl.Segmenter | null {
  if (cachedSegmenter) return cachedSegmenter;
  try {
    cachedSegmenter = new Intl.Segmenter();
    return cachedSegmenter;
  } catch {
    return null;
  }
}

/**
 * Deletes the last grapheme cluster from a string, supporting Unicode surrogate pairs
 * and combining character sequences (e.g. Vietnamese diacritics / decomposed characters).
 */
export function deleteLastGrapheme(str: string): string {
  if (!str) return "";
  const segmenter = getSegmenter();
  if (segmenter) {
    try {
      const segments = Array.from(segmenter.segment(str));
      return segments.slice(0, -1).map((s) => s.segment).join("");
    } catch {
      // ignore
    }
  }
  return str.slice(0, -1);
}

const COMBINING_MARK_REGEX = /\p{M}/u;
const ANSI_REGEX = /\x1b\[[0-9;]*m/g;
const charWidthCache = new Map<string, number>();

function computeCharWidth(char: string): number {
  // If it's a combining mark / non-spacing mark, its visual width is 0
  if (COMBINING_MARK_REGEX.test(char)) {
    return 0;
  }

  const code = char.codePointAt(0);
  if (code === undefined) return 0;
  
  // CJK Unified Ideographs, Extension A
  if (code >= 0x4E00 && code <= 0x9FFF) return 2;
  if (code >= 0x3400 && code <= 0x4DBF) return 2;
  
  // Hangul Syllables, Jamo
  if (code >= 0xAC00 && code <= 0xD7A3) return 2;
  if (code >= 0x1100 && code <= 0x11FF) return 2;
  
  // Fullwidth variants
  if (code >= 0xFF00 && code <= 0xFFEF) return 2;
  
  // Hiragana, Katakana, Bopomofo, CJK Radicals, Kanbun etc.
  if (code >= 0x3000 && code <= 0x30FF) return 2;
  
  // Emojis and Dingbats
  if (code >= 0x1F300 && code <= 0x1F9FF) return 2;
  if (code >= 0x1F600 && code <= 0x1F64F) return 2;
  if (code >= 0x1F680 && code <= 0x1F6FF) return 2;
  if (code >= 0x2600 && code <= 0x26FF) return 2;
  if (code >= 0x2700 && code <= 0x27BF) return 2;
  
  // Surrogates or characters outside BMP
  if (code >= 0x10000) return 2;
  
  return 1;
}

/**
 * Returns the visual terminal width of a single character code point.
 * Correctly assigns a width of 0 to Unicode combining marks (e.g. Vietnamese diacritics).
 */
export function getCharWidth(char: string): number {
  let w = charWidthCache.get(char);
  if (w !== undefined) return w;
  w = computeCharWidth(char);
  if (charWidthCache.size >= 2000) {
    charWidthCache.clear();
  }
  charWidthCache.set(char, w);
  return w;
}

/**
 * Returns the visual terminal width of a string, accounting for CJK characters,
 * emojis, surrogate pairs, and combining diacritics.
 */
export function getStringWidth(str: string): number {
  const clean = str.replace(ANSI_REGEX, "");
  let width = 0;
  for (const char of clean) {
    width += getCharWidth(char);
  }
  return width;
}

/**
 * Visual-width-aware text truncation. Truncates the text to at most `max` columns,
 * appending an ellipsis if truncated.
 */
export function truncateText(text: string, max: number): string {
  if (max <= 0) return "";
  const width = getStringWidth(text);
  if (width <= max) return text;
  
  let currentWidth = 0;
  let sliced = "";
  for (const char of text) {
    const charWidth = getCharWidth(char);
    if (currentWidth + charWidth > max - 1) {
      break;
    }
    currentWidth += charWidth;
    sliced += char;
  }
  return sliced + "…";
}

export interface WrapOptions {
  preserveIndent?: boolean;
}

export interface StyledSpan {
  text: string;
  isBold?: boolean;
  isCode?: boolean;
}

/**
 * Wraps a string into lines of at most `max` visual width.
 * Correctly handles Vietnamese diacritics, CJK characters, emojis, and newlines.
 */
export function wrapText(text: string, max: number, options?: WrapOptions): string[] {
  if (max <= 0) return [text];
  const lines: string[] = [];
  const rawLines = text.split("\n");

  for (const rawLine of rawLines) {
    if (!rawLine) {
      lines.push("");
      continue;
    }

    if (options?.preserveIndent) {
      const indentMatch = rawLine.match(/^\s*/);
      const indent = indentMatch ? indentMatch[0] : "";
      const indentWidth = getStringWidth(indent);
      
      if (indent.length === rawLine.length) {
        lines.push(rawLine);
        continue;
      }
      
      const content = rawLine.slice(indent.length);
      const contentMax = Math.max(Math.min(max, 4), max - indentWidth);
      const wrappedContent = wrapText(content, contentMax);
      
      for (const wrappedLine of wrappedContent) {
        lines.push(indent + wrappedLine);
      }
      continue;
    }

    let currentLine = "";
    let currentWidth = 0;
    const words = rawLine.split(/(\s+)/); // Keep whitespace as tokens

    for (const token of words) {
      if (!token) continue;
      const tokenWidth = getStringWidth(token);

      // If it fits on the current line, append it
      if (currentWidth + tokenWidth <= max) {
        currentLine += token;
        currentWidth += tokenWidth;
      } else {
        // If the token is a word and is wider than max, we have to force-break it
        if (tokenWidth > max && !/^\s+$/.test(token)) {
          // Flush the current line first if there's content
          if (currentLine) {
            lines.push(currentLine);
            currentLine = "";
            currentWidth = 0;
          }

          // Force wrap the long word character by character
          for (const char of token) {
            const charWidth = getCharWidth(char);
            if (currentWidth + charWidth > max) {
              lines.push(currentLine);
              currentLine = char;
              currentWidth = charWidth;
            } else {
              currentLine += char;
              currentWidth += charWidth;
            }
          }
        } else {
          // Standard word boundary wrap: flush current line and start new one
          if (currentLine) {
            lines.push(currentLine);
          }
          
          // If the token is just spaces at the start of a wrapped line, discard it
          if (/^\s+$/.test(token)) {
            currentLine = "";
            currentWidth = 0;
          } else {
            currentLine = token;
            currentWidth = tokenWidth;
          }
        }
      }
    }

    if (currentLine) {
      lines.push(currentLine);
    }
  }

  return lines;
}

/**
 * Parses a single line of text into styled spans by identifying markdown bold (**) and code (`) tags.
 */
export function parseInlineSpans(lineText: string): StyledSpan[] {
  const parts: StyledSpan[] = [];
  const regex = /(\*\*.*?\*\*|`.*?`)/g;
  let lastIndex = 0;
  let match;

  while ((match = regex.exec(lineText)) !== null) {
    const matchText = match[0];
    const matchIndex = match.index;

    if (matchIndex > lastIndex) {
      parts.push({ text: lineText.slice(lastIndex, matchIndex) });
    }

    if (matchText.startsWith("**") && matchText.endsWith("**")) {
      parts.push({ text: matchText.slice(2, -2), isBold: true });
    } else if (matchText.startsWith("`") && matchText.endsWith("`")) {
      parts.push({ text: matchText.slice(1, -1), isCode: true });
    }

    lastIndex = regex.lastIndex;
  }

  if (lastIndex < lineText.length) {
    parts.push({ text: lineText.slice(lastIndex) });
  }

  return parts;
}

/**
 * Wraps an array of StyledSpans into rows of at most `max` visual width.
 * Preserves the isBold and isCode styling properties for each segment of the wrapped text.
 */
export function wrapStyledSpans(spans: StyledSpan[], max: number): StyledSpan[][] {
  if (max <= 0) return [spans];
  
  const lines: StyledSpan[][] = [];
  let currentLine: StyledSpan[] = [];
  let currentWidth = 0;

  const tokens: (StyledSpan & { width: number })[] = [];
  for (const span of spans) {
    const words = span.text.split(/(\s+)/);
    for (const word of words) {
      if (!word) continue;
      tokens.push({
        text: word,
        isBold: span.isBold,
        isCode: span.isCode,
        width: getStringWidth(word),
      });
    }
  }

  for (const token of tokens) {
    if (currentWidth + token.width <= max) {
      currentLine.push(token);
      currentWidth += token.width;
    } else {
      if (token.width > max && !/^\s+$/.test(token.text)) {
        if (currentLine.length > 0) {
          lines.push(combineAdjacentSpans(currentLine));
          currentLine = [];
          currentWidth = 0;
        }

        let currentWordText = "";
        let currentWordWidth = 0;
        for (const char of token.text) {
          const charWidth = getCharWidth(char);
          if (currentWordWidth + charWidth > max) {
            if (currentWordText) {
              lines.push([{ text: currentWordText, isBold: token.isBold, isCode: token.isCode }]);
            }
            currentWordText = char;
            currentWordWidth = charWidth;
          } else {
            currentWordText += char;
            currentWordWidth += charWidth;
          }
        }
        if (currentWordText) {
          currentLine.push({ text: currentWordText, isBold: token.isBold, isCode: token.isCode });
          currentWidth = currentWordWidth;
        }
      } else {
        if (currentLine.length > 0) {
          lines.push(combineAdjacentSpans(currentLine));
        }
        
        if (/^\s+$/.test(token.text)) {
          currentLine = [];
          currentWidth = 0;
        } else {
          currentLine = [token];
          currentWidth = token.width;
        }
      }
    }
  }

  if (currentLine.length > 0) {
    lines.push(combineAdjacentSpans(currentLine));
  }

  return lines;
}

/**
 * Optimizes an array of StyledSpans by combining adjacent spans sharing identical styles.
 */
export function combineAdjacentSpans(spans: StyledSpan[]): StyledSpan[] {
  const combined: StyledSpan[] = [];
  for (const span of spans) {
    const cleanSpan: StyledSpan = { text: span.text };
    if (span.isBold) cleanSpan.isBold = true;
    if (span.isCode) cleanSpan.isCode = true;

    if (combined.length === 0) {
      combined.push(cleanSpan);
      continue;
    }
    const last = combined[combined.length - 1]!;
    if (last.isBold === cleanSpan.isBold && last.isCode === cleanSpan.isCode) {
      last.text += cleanSpan.text;
    } else {
      combined.push(cleanSpan);
    }
  }
  return combined;
}

/**
 * Robust scanner to identify candidate file/folder paths inside a string.
 * First extracts matches enclosed in single/double quotes, then splits the remaining text by whitespace/newlines.
 * Cleans up leading/trailing punctuation before returning.
 */
export function extractPathCandidates(text: string): string[] {
  if (!text) return [];
  const candidates: string[] = [];
  
  // 1. Extract quoted paths (handles space-containing filenames/paths)
  const quoteRegex = /"([^"\r\n]+)"|'([^'\r\n]+)'/g;
  let remainingText = text;
  let match;
  
  while ((match = quoteRegex.exec(text)) !== null) {
    const path = match[1] || match[2];
    if (path && path.trim()) {
      candidates.push(path.trim());
    }
  }
  
  // Strip quotes for remaining split
  remainingText = remainingText.replace(quoteRegex, " ");
  
  // 2. Split by whitespace/newlines
  const words = remainingText.split(/[\s\r\n]+/);
  for (const word of words) {
    if (!word) continue;
    
    // Clean up trailing/leading punctuation
    let cleaned = word.replace(/^[()[\]{},;.]+|[()[\]{},;.:?]+$/g, "");
    
    // Check path characteristics
    // If it looks like a slash command (starts with / but has no other slashes), ignore it
    const isSlashCommand = cleaned.startsWith("/") && !cleaned.slice(1).includes("/") && !cleaned.includes("\\");
    
    // Check path characteristics
    const isPathLike = !isSlashCommand && (
      cleaned.startsWith("@") || 
      cleaned.includes("/") || 
      cleaned.includes("\\") ||
      /^[a-zA-Z]:[/\\]/.test(cleaned) ||
      /\.[a-zA-Z0-9_]{1,10}$/.test(cleaned)
    );
      
    if (isPathLike && cleaned.length > 1) {
      if (!candidates.includes(cleaned)) {
        candidates.push(cleaned);
      }
    }
  }
  
  return candidates;
}



