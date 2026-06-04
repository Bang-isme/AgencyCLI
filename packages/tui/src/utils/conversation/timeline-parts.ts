import { isSystemActivityLine } from "./activity-parser.js";

/**
 * One ordered segment of an assistant message's content.
 *
 * The conversation render historically used TWO divergent parsers — the
 * streaming `partitionStreamContent` (buckets every line into 3 separate arrays:
 * text, then code, then activity — losing interleave order) and the final
 * `parseAssistantContent` (a different badge-regex categorizer). The same content
 * therefore rendered DIFFERENTLY once a turn finished, and tool/system activity
 * got flattened out of timeline order ("dumped into text"). This is the single
 * ordered categorizer both branches use instead: it walks the content ONCE and
 * groups consecutive same-kind lines while PRESERVING their original order, so a
 * `text → tool → text → tool` sequence renders in that exact order — the
 * opencode-style timeline.
 */
export type ConversationPart =
  | { kind: "text"; lines: string[] }
  /** Consecutive `⚡ [SYSTEM: …]` / tool-activity lines (rendered concisely, not verbatim). */
  | { kind: "activity"; lines: string[] }
  | { kind: "code"; language: string; lines: string[] };

const FENCE = "```";

/**
 * Parse assistant content into ordered parts. Pure (no React/IO) so the ordering
 * + grouping contract is unit-testable. Consecutive lines of the same kind are
 * coalesced into one part; code fences open/close a `code` part. Empty text
 * parts (only blank lines) are dropped so they can't add phantom rows.
 */
export function parseConversationParts(content: string): ConversationPart[] {
  const safe = typeof content === "string" ? content : "";
  const parts: ConversationPart[] = [];
  const lines = safe.split("\n");

  let inCode = false;
  let codeLang = "";
  let codeLines: string[] = [];

  const flushCode = () => {
    parts.push({ kind: "code", language: codeLang, lines: codeLines });
    codeLines = [];
    codeLang = "";
  };

  const pushLine = (kind: "text" | "activity", line: string) => {
    const last = parts[parts.length - 1];
    if (last && last.kind === kind) {
      last.lines.push(line);
    } else {
      parts.push({ kind, lines: [line] });
    }
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith(FENCE)) {
      if (inCode) {
        flushCode();
        inCode = false;
      } else {
        codeLang = trimmed.slice(FENCE.length).trim();
        inCode = true;
      }
      continue;
    }
    if (inCode) {
      codeLines.push(line);
      continue;
    }
    if (isSystemActivityLine(line)) {
      pushLine("activity", line);
    } else {
      pushLine("text", line);
    }
  }

  // An unterminated code fence (mid-stream) still flushes what we have so far.
  if (inCode) flushCode();

  // Drop text parts that are entirely blank (no phantom rows), trim leading/
  // trailing blank lines, and collapse interior runs of ≥2 blank lines to a
  // single blank line inside surviving text parts. The interior collapse is what
  // closes the tall empty "hole" left after `stripToolCalls` removes a tool-call
  // block (its surrounding newlines join into `\n\n\n\n`) — and it tidies any
  // hand-authored double blanks too, giving opencode-style single-line spacing.
  return parts
    .map((p) => {
      if (p.kind !== "text") return p;
      const trimmedLines = [...p.lines];
      while (trimmedLines.length > 0 && trimmedLines[0]!.trim() === "") trimmedLines.shift();
      while (trimmedLines.length > 0 && trimmedLines[trimmedLines.length - 1]!.trim() === "") trimmedLines.pop();
      const collapsed: string[] = [];
      let prevBlank = false;
      for (const line of trimmedLines) {
        const isBlank = line.trim() === "";
        if (isBlank && prevBlank) continue;
        collapsed.push(line);
        prevBlank = isBlank;
      }
      return { kind: "text" as const, lines: collapsed };
    })
    .filter((p) => !(p.kind === "text" && p.lines.length === 0));
}
