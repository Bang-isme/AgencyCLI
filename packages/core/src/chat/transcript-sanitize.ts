/**
 * Strip leaked tool-call markup and collapse noisy narration from assistant
 * transcript text before it is stored or rendered.
 *
 * Provider models (MiniMax, GLM, etc.) emit many malformed variants — missing
 * `<`, fused tag names (`>update_planname>`), split across lines (`_call` then
 * `>foo>`), attribute payloads (`name="todos">[{…}]`), and line-range typos
 * (`_line>210start_line>`). This module normalizes all of them before display.
 */

const TOOL_BLOCK_TAGS = [
  "antml:function_calls",
  "antml:function_call",
  "antml:parameter",
  "antml:invoke",
  "function_commands",
  "function_command",
  "function_calls",
  "function_call",
  "minimax:tool_call",
  "invoke_call",
  "tool_call",
  "invoke",
  "function",
];

const TOOL_CLOSE_TAGS =
  "antml:function_calls|antml:function_call|antml:parameter|antml:invoke|function_commands|function_command|function_calls|function_call|minimax:tool_call|invoke_call|tool_call|invoke|function|CommandLine|command|param|parameter|arg|think|mm:think|thought|todos|tasks|steps|path|pattern|content|start_line|end_line|Line|line";

const TOOL_LIKE_TAG =
  /<\/?[\w:.-]*(?:function|invoke|tool|command|call|param|antml|minimax|line|todos|tasks)[\w:.-]*(?:>|(?=\s*$))/gim;

const REPETITIVE_WAIT_LINE =
  /^(?:đợi(?:\s+[^\n]+)?\s*:?\s*|wait\s+(?:more|further|for\b[^\n]*):?\s*)$/iu;

const MARKUP_ONLY_LINE = /^<\/?[\w:.-]+\s*\/?>\s*$/;

const FAKE_SYSTEM_LINE =
  /^\s*(?:->\s*)?(?:⚠\s*)?(?:\[\s*)?SYSTEM\s*:/i;

const TOOL_PARAM_TAG_NAMES =
  "path|pattern|content|command|todos|tasks|agentId|task|batchLabel|label|dispatchId|old_string|new_string|glob|query|description|attempt|steps|start_line|end_line";

const MALFORMED_TOOL_OPENER = /_call\s+name\s*=\s*["']([^"']+)["']\s*>/gim;

const SPLIT_CALL_LINE = /(?:^|\n)\s*_call\s*(?=\n|$)/gim;

const FUSED_TOOL_LINE = /^>\s*[a-z][a-z0-9_]*(?:name|path|line|parameter|arg)?>\s*$/i;

const ATTR_TOOL_OPENER = /name\s*=\s*["'](?:todos|tasks|path|pattern|content|command|steps|label|batchLabel|start_line|end_line)["']\s*>/gi;

/** True when a trimmed line is provider tool markup (any known variant). */
export function isProviderToolLeakLine(trimmed: string): boolean {
  if (!trimmed) return false;
  if (/^parameter>?$/i.test(trimmed)) return true;
  if (/^_call\s*$/i.test(trimmed)) return true;
  if (/^tool_call>?$/i.test(trimmed)) return true;
  if (/^invoke>?$/i.test(trimmed)) return true;
  if (FUSED_TOOL_LINE.test(trimmed)) return true;
  if (/^>\s*.+(?:path|pattern|command|content|parameter|arg|binpath|logpath|name|line|EndLine|start_line|end_line)>$/i.test(trimmed)) {
    return true;
  }
  if (/^>[A-Za-z]:\\.+(?:path|pattern|command|content|binpath|logpath)>$/i.test(trimmed)) return true;
  if (/^<\/?\s*(?:param|parameter|arg)\b/i.test(trimmed)) return true;
  if (/^<(?:path|pattern|content|command|todos|tasks|steps|start_line|end_line)\b/i.test(trimmed)) return true;
  if (/^name\s*=\s*["'][^"']+["']\s*>\s*(\[|\{)?/i.test(trimmed)) return true;
  if (/^_line>\d+(?:start_line|StartLine)?>/i.test(trimmed)) return true;
  if (/^Line>\d+(?:EndLine|end_line)?>/i.test(trimmed)) return true;
  if (/^(?:start|end)_line\s*>/i.test(trimmed)) return true;
  if (/^\d+(?:start|End)Line>/i.test(trimmed)) return true;
  if (/^\[\{"(?:step|content|id)"/i.test(trimmed)) return true;
  if (/^\{"(?:step|content|status)"/i.test(trimmed)) return true;
  if (/^[\]}],?\s*$/.test(trimmed) && trimmed.length < 8) return true;
  if (/^>(?:cd|git|npm|npx|pnpm|yarn|node|python|docker|curl|wget|ls|dir|cat|type|head|tail|grep|find|mkdir|rm|mv|cp|echo|powershell|pwsh|bash|sh|tsc|eslint|next)\b/i.test(trimmed)) {
    return true;
  }
  if (/^>[A-Za-z]:\\.+?(?:&&|\||;)/.test(trimmed)) return true;
  if (/^<\/?[A-Za-zÀ-ỹĐđ][^>\n]{0,120}:?\s*$/.test(trimmed)) return true;
  if (/^<\/?(?:Tốt|Đã|Tóm|Bước|Step|Note|OK|Done)\b/i.test(trimmed)) return true;
  return false;
}

function stripNarrativePseudoTags(text: string): string {
  return text
    .replace(/<\/?(?:Tốt|Đã|Tóm|Bước|Step|Note|OK|Done)\b[^>\n]{0,200}>?/giu, "")
    .replace(/<\/?[A-Za-zÀ-ỹĐđ][A-Za-zÀ-ỹĐđ0-9\s\-–—]{0,80}:\s*(?=\n|$)/giu, "");
}

function stripShellPromptLines(text: string): string {
  return text
    .split("\n")
    .filter((line) => {
      const t = line.trim();
      if (!t.startsWith(">")) return true;
      const cmd = t.slice(1).trim();
      if (/^(?:cd|git|npm|npx|pnpm|yarn|node|python|docker|curl|wget|ls|dir|cat|type|head|tail|grep|find|mkdir|rm|mv|cp|echo|powershell|pwsh|bash|sh|tsc|eslint|next)\b/i.test(cmd)) {
        return false;
      }
      if (/^[A-Za-z]:\\.+?(?:&&|\||;)/.test(cmd)) return false;
      if (/\s&&\s|\s\|\|\s/.test(cmd) && !/(?:path|pattern|parameter)>$/i.test(cmd)) return false;
      return true;
    })
    .join("\n");
}

function stripFakeSystemLines(text: string): string {
  return text
    .split("\n")
    .filter((line) => !FAKE_SYSTEM_LINE.test(line.trim()))
    .join("\n");
}

/** Hold fenced code blocks aside while aggressive markup strips run on prose. */
function protectCodeFences(text: string): { text: string; fences: string[] } {
  const fences: string[] = [];
  const out = text.replace(/```[\s\S]*?(?:```|$)/g, (m) => {
    const id = fences.length;
    fences.push(m);
    return `\x00FENCE${id}\x00`;
  });
  return { text: out, fences };
}

function restoreCodeFences(text: string, fences: string[]): string {
  return text.replace(/\x00FENCE(\d+)\x00/g, (_, i) => fences[Number(i)] ?? "");
}

function findOpeningTagIndex(text: string, tag: string): number {
  let pos = 0;
  const needle = `<${tag}`;
  while (pos < text.length) {
    const idx = text.indexOf(needle, pos);
    if (idx === -1) return -1;
    if (text[idx + 1] === "/") {
      pos = idx + 1;
      continue;
    }
    return idx;
  }
  return -1;
}

function stripMarkupOnlyLines(text: string): string {
  return text
    .split("\n")
    .filter((line) => !MARKUP_ONLY_LINE.test(line.trim()))
    .join("\n");
}

function findJsonArraySpan(text: string): { start: number; end: number } | null {
  const start = text.search(/\[/);
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let quote: '"' | "'" | null = null;
  let escape = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i]!;
    if (inString) {
      if (escape) {
        escape = false;
        continue;
      }
      if (ch === "\\") {
        escape = true;
        continue;
      }
      if (ch === quote) {
        inString = false;
        quote = null;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      inString = true;
      quote = ch;
      continue;
    }
    if (ch === "[") depth++;
    else if (ch === "]") {
      depth--;
      if (depth === 0) return { start, end: i + 1 };
    }
  }
  return null;
}

function stripInlineToolFragments(text: string): string {
  return text
    .replace(/\btool_call>\s*/gi, "")
    .replace(/(?:^|\n)\s*_call\s*(?=\n|$)/gim, "\n")
    .replace(/(?:^|\n)\s*>\s*[a-z][a-z0-9_]*(?:name|path|line|parameter)?>\s*(?=\n|$)/gim, "\n")
    .replace(/name\s*=\s*["'](?:todos|tasks|path|pattern|content|command|steps|label|batchLabel|start_line|end_line)["']\s*>\s*/gi, "")
    .replace(/_line>\d+(?:start_line|StartLine)?>/gi, "")
    .replace(/Line>\d+(?:EndLine|end_line)?>/gi, "")
    .replace(/(?:^|\n)\s*invoke>\s*(?=\n|$)/gim, "\n")
    .replace(/(?:^|\n)\s*parameter>\s*(?=\n|$)/gim, "\n");
}

function stripProviderToolLeakLines(text: string): string {
  return text
    .split("\n")
    .filter((line) => !isProviderToolLeakLine(line.trim()))
    .join("\n");
}

function findMalformedToolBodyEnd(text: string, bodyStart: number): number {
  if (bodyStart >= text.length) return bodyStart;

  const rest = text.slice(bodyStart);
  if (/^\s*\[/.test(rest)) {
    const span = findJsonArraySpan(rest);
    if (span) return bodyStart + span.end;
  }

  let lineStart = bodyStart;
  while (lineStart < text.length) {
    let lineEnd = text.indexOf("\n", lineStart);
    if (lineEnd === -1) lineEnd = text.length;
    const trimmed = text.slice(lineStart, lineEnd).trim();

    if (/^_call\s+name\s*=/i.test(trimmed)) break;
    if (/^<tool_call\b/i.test(trimmed)) break;
    if (/^name\s*=\s*["']/i.test(trimmed)) break;
    if (FUSED_TOOL_LINE.test(trimmed)) {
      lineStart = lineEnd < text.length ? lineEnd + 1 : text.length;
      continue;
    }

    if (isProviderToolLeakLine(trimmed)) {
      lineStart = lineEnd < text.length ? lineEnd + 1 : text.length;
      continue;
    }

    break;
  }
  return lineStart;
}

/** Remove `_call`-only line + following fused/param lines until prose resumes. */
function stripSplitCallRegions(text: string): string {
  let result = text;
  let match: RegExpExecArray | null;
  SPLIT_CALL_LINE.lastIndex = 0;
  const starts: number[] = [];
  while ((match = SPLIT_CALL_LINE.exec(result)) !== null) {
    starts.push(match.index);
  }
  for (let i = starts.length - 1; i >= 0; i--) {
    const index = starts[i]!;
    const bodyStart = index + (result.slice(index).match(/^(?:\n\s*)?_call\s*/i)?.[0]?.length ?? 5);
    let bodyEnd = findMalformedToolBodyEnd(result, bodyStart);
    const nextCall = result.slice(bodyStart).search(/(?:^|\n)\s*(?:_call\s+name\s*=|_call\s*(?:\n|$)|<tool_call\b)/im);
    if (nextCall >= 0) bodyEnd = Math.min(bodyEnd, bodyStart + nextCall);
    result = result.slice(0, index) + result.slice(bodyEnd);
  }
  return result;
}

function stripAttributeToolRegions(text: string): string {
  let result = text;
  let m: RegExpExecArray | null;
  ATTR_TOOL_OPENER.lastIndex = 0;
  const starts: number[] = [];
  while ((m = ATTR_TOOL_OPENER.exec(result)) !== null) {
    starts.push(m.index);
  }
  for (let i = starts.length - 1; i >= 0; i--) {
    const index = starts[i]!;
    const bodyStart = index + (result.slice(index).match(ATTR_TOOL_OPENER)?.[0]?.length ?? 0);
    let bodyEnd = findMalformedToolBodyEnd(result, bodyStart);
    result = result.slice(0, index) + result.slice(bodyEnd);
  }
  return result;
}

function stripMalformedToolCallRegions(text: string): string {
  let result = text;
  const openers: Array<{ index: number; openerLen: number }> = [];

  let m: RegExpExecArray | null;
  MALFORMED_TOOL_OPENER.lastIndex = 0;
  while ((m = MALFORMED_TOOL_OPENER.exec(result)) !== null) {
    openers.push({ index: m.index, openerLen: m[0].length });
  }

  for (let i = openers.length - 1; i >= 0; i--) {
    const { index, openerLen } = openers[i]!;
    const bodyStart = index + openerLen;
    const rest = result.slice(bodyStart);

    let bodyEnd = findMalformedToolBodyEnd(result, bodyStart);

    const nextCall = rest.search(/(?:^|\n)\s*(?:_call\s+name\s*=|_call\s*(?:\n|$)|<tool_call\b)/im);
    if (nextCall >= 0) bodyEnd = Math.min(bodyEnd, bodyStart + nextCall);

    const nextToolCall = rest.search(/<tool_call\b/i);
    if (nextToolCall >= 0) bodyEnd = Math.min(bodyEnd, bodyStart + nextToolCall);

    result = result.slice(0, index) + result.slice(bodyEnd);
  }

  return result;
}

function stripOrphanToolParamTags(text: string): string {
  const paired = new RegExp(
    `<(?:${TOOL_PARAM_TAG_NAMES})\\b[^>]*>[\\s\\S]*?<\\/(?:${TOOL_PARAM_TAG_NAMES})\\s*>`,
    "gi"
  );
  let result = text.replace(paired, "");
  const unclosed = new RegExp(
    `<(?:${TOOL_PARAM_TAG_NAMES})\\b[^>]*>[\\s\\S]*?(?=\\n\\s*(?:_call\\s+name\\s*=|<tool_call\\b|$))`,
    "gi"
  );
  result = result.replace(unclosed, "");
  return result;
}

/** Strip tool-leak lines inside markdown code fences (incl. unclosed fences while streaming). */
function stripLeaksInFencedBlocks(text: string): string {
  let out = "";
  let cursor = 0;

  while (cursor < text.length) {
    const open = text.indexOf("```", cursor);
    if (open === -1) {
      out += text.slice(cursor);
      break;
    }

    out += text.slice(cursor, open);
    const headerEnd = text.indexOf("\n", open);
    if (headerEnd === -1) {
      out += text.slice(open);
      break;
    }

    out += text.slice(open, headerEnd + 1);
    const close = text.indexOf("\n```", headerEnd + 1);
    const bodyEnd = close === -1 ? text.length : close;
    const body = text.slice(headerEnd + 1, bodyEnd);
    const cleaned = body
      .split("\n")
      .filter((line) => !isProviderToolLeakLine(line.trim()))
      .map((line) => stripInlineToolFragments(line))
      .join("\n");
    out += cleaned;
    cursor = bodyEnd;
    if (close !== -1) {
      const closeEnd = text.indexOf("\n", close + 1);
      out += text.slice(close, closeEnd === -1 ? text.length : closeEnd + 1);
      cursor = closeEnd === -1 ? text.length : closeEnd + 1;
    }
  }

  return out;
}

function stripStandardToolBlocks(text: string): string {
  let result = text;

  while (true) {
    let firstStartIndex = -1;
    for (const tag of TOOL_BLOCK_TAGS) {
      const idx = findOpeningTagIndex(result, tag);
      if (idx !== -1 && (firstStartIndex === -1 || idx < firstStartIndex)) {
        firstStartIndex = idx;
      }
    }
    if (firstStartIndex === -1) break;

    let firstEndIndex = -1;
    let closingTagLength = 0;
    const closeRe = new RegExp(
      `<\\/\\s*(${TOOL_BLOCK_TAGS.map((t) => t.replace(/:/g, "\\:")).join("|")})\\s*>`,
      "g"
    );
    closeRe.lastIndex = firstStartIndex;
    const closeMatch = closeRe.exec(result);
    if (closeMatch) {
      firstEndIndex = closeMatch.index;
      closingTagLength = closeMatch[0].length;
    }

    if (firstEndIndex !== -1) {
      result = result.slice(0, firstStartIndex) + result.slice(firstEndIndex + closingTagLength);
    } else {
      result = result.slice(0, firstStartIndex);
      break;
    }
  }

  return result;
}

/**
 * Remove XML-style tool call blocks and orphan provider markup from assistant text.
 */
export function stripToolMarkup(text: string): string {
  let result = typeof text === "string" ? text : "";
  const MAX_PASSES = 4;

  for (let pass = 0; pass < MAX_PASSES; pass++) {
    const before = result;

    result = stripStandardToolBlocks(result);

    result = result.replace(
      new RegExp(`<\\/\\s*(?:${TOOL_CLOSE_TAGS})(?:>|(?=\\s*$))`, "gim"),
      ""
    );
    result = result.replace(
      new RegExp(`<\\/?\\s*(?:${TOOL_CLOSE_TAGS})\\b[^>\\n]*`, "gi"),
      ""
    );
    result = result.replace(TOOL_LIKE_TAG, "");
    result = result.replace(/\]?<?\]?minimax\[>[\][]*/gi, "");

    const { text: protectedText, fences } = protectCodeFences(result);
    let stripped = stripMalformedToolCallRegions(protectedText);
    stripped = stripSplitCallRegions(stripped);
    stripped = stripAttributeToolRegions(stripped);
    result = restoreCodeFences(stripped, fences);

    result = stripInlineToolFragments(result);

    // Strip leading stray tag prefixes (like </) before we filter leak lines,
    // so that long prose lines starting with </ are not completely deleted.
    result = result.replace(/^\s*<\/+\s*(?=[^\s>])/gmu, "");
    result = result.replace(/^\s*<\/?\s*$/gm, "");

    result = stripProviderToolLeakLines(result);
    result = stripOrphanToolParamTags(result);
    result = stripLeaksInFencedBlocks(result);
    result = stripNarrativePseudoTags(result);
    result = stripShellPromptLines(result);

    result = result.replace(/_call\s+name\s*=\s*["'][^"']+["']\s*>/gim, "");
    result = result.replace(/(?:^|\n)\s*Label>\s*[\s\S]*?\s*Label>/gim, "\n");

    result = result.replace(
      new RegExp(
        `<(?:${TOOL_BLOCK_TAGS.map((t) => t.replace(/:/g, "\\:")).join("|")}|param|parameter|arg|think|mm:think|thought)\\b[^>]*>?$`,
        "im"
      ),
      ""
    );
    result = result.replace(
      new RegExp(`(?:<\\/\\s*(?:${TOOL_CLOSE_TAGS})(?:>|(?=\\s*$)))+`, "gim"),
      ""
    );

    result = stripMarkupOnlyLines(result);
    result = result.replace(/\n{3,}/g, "\n\n");

    if (result === before) break;
  }

  return result;
}

export function collapseRepetitiveWaitLines(text: string): string {
  const lines = text.split("\n");
  const out: string[] = [];
  let inWaitRun = false;
  for (const line of lines) {
    if (REPETITIVE_WAIT_LINE.test(line.trim())) {
      if (!inWaitRun) {
        out.push(line);
        inWaitRun = true;
      }
      continue;
    }
    inWaitRun = false;
    out.push(line);
  }
  return out.join("\n");
}

export function sanitizeAssistantTranscript(text: string): string {
  return collapseRepetitiveWaitLines(stripFakeSystemLines(stripToolMarkup(text)));
}

/**
 * Lightweight sanitize for live streaming — one pass, no wait-line collapse.
 * Full {@link sanitizeAssistantTranscript} runs at turn end / on disk save.
 */
export function sanitizeStreamingPreview(text: string): string {
  if (!text) return "";
  let result = stripFakeSystemLines(text);
  result = stripStandardToolBlocks(result);
  result = stripMalformedToolCallRegions(result);
  result = stripSplitCallRegions(result);
  result = stripAttributeToolRegions(result);
  result = stripInlineToolFragments(result);

  // Strip leading stray tag prefixes (like </) before we filter leak lines,
  // so that long prose lines starting with </ are not completely deleted.
  result = result.replace(/^\s*<\/+\s*(?=[^\s>])/gmu, "");
  result = result.replace(/^\s*<\/?\s*$/gm, "");

  result = stripProviderToolLeakLines(result);
  result = stripLeaksInFencedBlocks(result);
  result = stripNarrativePseudoTags(result);
  result = stripShellPromptLines(result);
  result = result.replace(/_call\s+name\s*=\s*["'][^"']+["']\s*>/gim, "");
  result = result.replace(/\btool_call>\s*/gi, "");

  return result;
}

/** True when a streaming delta is only leaked tool markup (drop before accumulating). */
export function isLeakedToolMarkupDelta(delta: string): boolean {
  const t = delta.trim();
  if (!t) return false;
  if (isProviderToolLeakLine(t)) return true;
  if (MARKUP_ONLY_LINE.test(t)) return true;
  if (/^<\/?[\w:.-]*>?$/i.test(t)) return true;
  if (/_call\s+name\s*=\s*["'][^"']+["']\s*>/.test(t) && t.length < 240) return true;
  if (
    /^<\/?\s*[\w:.-]*(?:function|invoke|tool|command|call|param|parameter|arg|antml|minimax|line|todos)/i.test(
      t
    ) &&
    t.length < 160 &&
    !/^import\s/i.test(t)
  ) {
    return true;
  }
  return false;
}
