import React, { useMemo, memo, useState, useEffect } from "react";
import { Box, Text } from "ink";
import type { ThemeTokens } from "../themes/registry.js";
import type { SessionMessage } from "../state/messages.js";
import type { SubagentStatus } from "../state/subagent-status.js";
import { parseToolCalls, getRuntimeFlags } from "@agency/core";
import { EmptyChat } from "./EmptyChat.js";
import { contentWidth as measureContentWidth } from "../layout/terminal-layout.js";

/** Verb shown in the per-message file-change summary, by write-tool name. */
const FILE_TOOL_VERB: Record<string, string> = {
  write_file: "write",
  append_file: "append",
  edit_file: "edit",
  ast_edit: "edit",
  batch_edit: "edit",
  delete_file: "delete",
  move_file: "rename",
  create_directory: "create dir",
};

export interface FileChange {
  verb: string;
  path: string;
}

/**
 * Honest, flat file-change summary for an assistant message: which files the
 * turn actually changed, read from the RAW content's write/edit/delete/move tool
 * calls (the `⚡ Tool "edit_file" completed: edited` lines drop the path, so this
 * fills that gap). Deduped per (verb, path); empty when there are no write tools.
 * Pure + exported for unit testing.
 */
export function extractFileChanges(rawContent: string): FileChange[] {
  if (typeof rawContent !== "string" || !rawContent.includes("<")) return [];
  let calls: { name: string; arguments: Record<string, string> }[];
  try {
    calls = parseToolCalls(rawContent);
  } catch {
    return [];
  }
  const out: FileChange[] = [];
  const seen = new Set<string>();
  for (const c of calls) {
    const verb = FILE_TOOL_VERB[c.name];
    if (!verb) continue;
    let path: string;
    if (c.name === "move_file") {
      const src = (c.arguments.source ?? "").trim();
      const dst = (c.arguments.destination ?? "").trim();
      if (!src && !dst) continue;
      path = dst ? `${src} → ${dst}` : src;
    } else {
      path = (c.arguments.path ?? "").trim();
    }
    if (!path) continue;
    const key = `${verb}:${path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ verb, path });
  }
  return out;
}

export interface VirtualLine {
  type: "header" | "body" | "spacer";
  messageIdx: number;
  lineIdx?: number;
  text?: string;
}

/** Kept for compatibility, but internally uses calculateFormattedLines length */
export function calculateVirtualLines(messages: SessionMessage[]): VirtualLine[] {
  const lines: VirtualLine[] = [];
  messages.forEach((m, mIdx) => {
    lines.push({ type: "header", messageIdx: mIdx });
    const safeContent = typeof m.content === "string" ? stripToolCalls(m.content) : "";
    const bodyLines = safeContent.split("\n");
    bodyLines.forEach((text, lIdx) => {
      lines.push({ type: "body", messageIdx: mIdx, lineIdx: lIdx, text });
    });
    lines.push({ type: "spacer", messageIdx: mIdx });
  });
  return lines;
}

export function getMaxScrollOffset(
  virtualLinesCount: number,
  conversationHeight: number,
  survivalModeActive = false
): number {
  const isScrollActive = !survivalModeActive && virtualLinesCount > conversationHeight;
  const lockedViewportHeight = isScrollActive ? conversationHeight - 2 : conversationHeight;
  return Math.max(0, virtualLinesCount - lockedViewportHeight);
}

import { wrapText, parseInlineSpans, getStringWidth, type StyledSpan } from "../utils/text.js";
import { useTick } from "../motion/useTick.js";
import { frameAt, SPINNER_FRAMES } from "../motion/text.js";
import { LIFECYCLE_GLYPHS } from "../motion/design-system.js";
import { getBadgeStyles } from "../utils/conversation/tool-labels.js";
import { isSystemActivityLine, isSubagentNotice, isThinkingOrExploreNotice } from "../utils/conversation/activity-parser.js";
import { formatTechnicalSubLine, SubagentStepRow } from "./conversation/SubagentStepRow.js";
import { SystemActivityLine, toConciseTelemetry } from "./conversation/TraceTelemetry.js";
import { parseConversationParts, type ConversationPart } from "../utils/conversation/timeline-parts.js";
import { getLoopLag, getDegradationTier, writeRawStdout } from "../terminal/screen.js";
import fs from "fs";
import path from "path";
import v8 from "v8";

export interface FormattedLine {
  key: string;
  element: React.ReactNode;
  priority?: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";
  isImmutable?: boolean;
}

class FormattedLinePool {
  public acquire(
    key: string,
    element: React.ReactNode,
    priority: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW" = "MEDIUM"
  ): FormattedLine {
    return { key, element, priority, isImmutable: true };
  }

  public reset() {}
}

const linePool = new FormattedLinePool();

// getBadgeStyles and formatTechnicalSubLine extracted to utils/conversation/tool-labels and components/conversation/SubagentStepRow

export interface AssistantBlock {
  type: "text" | "code" | "action";
  badge?: string;
  description?: string;
  subLines?: string[];
  language?: string;
  code?: string;
  text?: string;
}

export function stripToolCalls(text: string): string {
  // Assistant message content can be `undefined` at runtime even though the type
  // says `string`: App patches `content: turn.body || undefined`, and a
  // `Partial<SessionMessage>` widens `content` to `string | undefined`. This
  // helper runs in the render-time line-measurement pass
  // (`calculateFormattedLines`), so a non-string here threw "Cannot read
  // properties of undefined (reading 'indexOf')" and crashed the whole App
  // render into the error-boundary recovery loop. Coerce defensively, exactly
  // like the sibling `parseAssistantContent` already does with `safeContent`.
  let result = typeof text === "string" ? text : "";
  const tags = ["tool_call", "invoke", "invoke_call"];

  while (true) {
    let firstStartIndex = -1;

    for (const tag of tags) {
      const idx = result.indexOf(`<${tag}`);
      if (idx !== -1 && (firstStartIndex === -1 || idx < firstStartIndex)) {
        firstStartIndex = idx;
      }
    }

    if (firstStartIndex === -1) {
      break;
    }

    let firstEndIndex = -1;
    let closingTagLength = 0;

    for (const tag of tags) {
      const idx = result.indexOf(`</${tag}>`, firstStartIndex);
      if (idx !== -1 && (firstEndIndex === -1 || idx < firstEndIndex)) {
        firstEndIndex = idx;
        closingTagLength = `</${tag}>`.length;
      }
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

export function parseAssistantContent(content: string): AssistantBlock[] {
  const blocks: AssistantBlock[] = [];
  const safeContent = typeof content === "string" ? content : "";
  const lines = safeContent.split("\n");

  let currentTextLines: string[] = [];
  let inCodeBlock = false;
  let codeLanguage = "";
  let codeLines: string[] = [];

  let currentAction: { badge: string; description: string; subLines: string[] } | null = null;

  const flushText = () => {
    if (currentTextLines.length > 0) {
      blocks.push({ type: "text", text: currentTextLines.join("\n") });
      currentTextLines = [];
    }
  };

  const flushAction = () => {
    if (currentAction) {
      blocks.push({
        type: "action",
        badge: currentAction.badge,
        description: currentAction.description,
        subLines: currentAction.subLines,
      });
      currentAction = null;
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const trimmed = line.trim();

    // Handle Markdown code block fences
    if (trimmed.startsWith("```")) {
      if (inCodeBlock) {
        // End of code block
        flushAction();
        flushText();
        blocks.push({
          type: "code",
          language: codeLanguage,
          code: codeLines.join("\n"),
        });
        codeLines = [];
        inCodeBlock = false;
      } else {
        // Start of code block
        flushAction();
        flushText();
        codeLanguage = trimmed.slice(3).trim();
        inCodeBlock = true;
      }
      continue;
    }

    if (inCodeBlock) {
      codeLines.push(line);
      continue;
    }

    // Check for high-contrast badge/action pattern
    const badgeMatch = line.match(/^([A-Z\s]{4,20})(?:\s+(.*))?$/);
    const knownBadges = [
      "EXPLORE", "READ", "WRITE", "TODOS", "ENTER PLAN MODE",
      "PLAN MODE", "HARNESS", "GATE", "SYSTEM", "GOAL",
      "TODO", "DONE", "RUNNING"
    ];

    if (badgeMatch && knownBadges.includes(badgeMatch[1]!.trim())) {
      flushAction();
      flushText();
      const badge = badgeMatch[1]!.trim();
      const description = badgeMatch[2]?.trim() ?? "";
      currentAction = {
        badge,
        description,
        subLines: [],
      };
      continue;
    }

    // Check if line is a sub-line of an active action (starts with tree indent or checklist bullets)
    if (currentAction && (trimmed.startsWith("└") || trimmed.startsWith("L") || line.startsWith("  ") || trimmed.startsWith("-") || trimmed.startsWith("□") || trimmed.startsWith("■"))) {
      currentAction.subLines.push(line);
      continue;
    }

    // Otherwise, it's regular text line
    flushAction();
    if (line.trim() || currentTextLines.length > 0) {
      currentTextLines.push(line);
    }
  }

  flushAction();
  flushText();

  return blocks;
}

interface RenderPartsContext {
  mId: string;
  innerWidth: number;
  prefixColor: string;
  theme: ThemeTokens;
  isStreamingActive: boolean;
  tick: number;
}

/**
 * Render an assistant message as ONE ordered activity timeline (flag
 * `timelineParts`). Walks {@link parseConversationParts} output in arrival order
 * so text, tool/`[SYSTEM:]` activity, and code interleave exactly as they
 * happened — the opencode-style timeline — instead of the legacy dual-parser
 * render that bucketed/re-ordered them and flattened activity into text. Activity
 * lines render concisely via {@link toConciseTelemetry} (no verbatim `[SYSTEM:]`
 * dumps). Flat lines only — fits the line-pool, never a bordered card.
 */
function renderConversationParts(parts: ConversationPart[], ctx: RenderPartsContext): FormattedLine[] {
  const { mId, innerWidth, prefixColor, theme, isStreamingActive, tick } = ctx;
  const out: FormattedLine[] = [];
  const wrapWidth = Math.max(4, innerWidth - 2);
  const lastPartIdx = parts.length - 1;

  parts.forEach((part, pIdx) => {
    if (part.kind === "text") {
      part.lines.forEach((rawLine, lIdx) => {
        const wrapped = wrapText(rawLine, wrapWidth);
        (wrapped.length ? wrapped : [""]).forEach((lineText, wIdx) => {
          out.push(linePool.acquire(
            `${mId}-tl-${pIdx}-text-${lIdx}-${wIdx}`,
            (
              <Box flexDirection="row" width={innerWidth}>
                <Text color={prefixColor}>│ </Text>
                <Box flexGrow={1} overflow="hidden">{formatInlineText(lineText, theme)}</Box>
              </Box>
            ),
            "MEDIUM"
          ));
        });
      });
    } else if (part.kind === "activity") {
      part.lines.forEach((line, lIdx) => {
        const isActive = isStreamingActive && pIdx === lastPartIdx && lIdx === part.lines.length - 1;
        out.push(linePool.acquire(
          `${mId}-tl-${pIdx}-act-${lIdx}`,
          (
            <Box flexDirection="row" width={innerWidth}>
              <Text color={theme.muted}>│ </Text>
              <Box flexGrow={1} overflow="hidden">{toConciseTelemetry(line, theme, isActive, tick)}</Box>
            </Box>
          ),
          "HIGH"
        ));
      });
    } else {
      // code: line-numbered, monospaced; flat rows (no border).
      const maxLineNumWidth = String(Math.max(1, part.lines.length)).length;
      part.lines.forEach((codeLine, lIdx) => {
        const lineNum = String(lIdx + 1).padStart(maxLineNumWidth, " ");
        out.push(linePool.acquire(
          `${mId}-tl-${pIdx}-code-${lIdx}`,
          (
            <Box flexDirection="row" width={innerWidth}>
              <Text color={prefixColor}>│ </Text>
              <Text color={theme.muted}>  {lineNum} │ </Text>
              <Box flexGrow={1} overflow="hidden"><Text color={theme.text} backgroundColor={theme.panel}>{codeLine}</Text></Box>
            </Box>
          ),
          "HIGH"
        ));
      });
    }
    // Spacer between parts (skip after the last so the message ends tight).
    if (pIdx < lastPartIdx) {
      out.push(linePool.acquire(
        `${mId}-tl-${pIdx}-sp`,
        (
          <Box flexDirection="row" width={innerWidth}>
            <Text color={prefixColor}>│ </Text>
            <Text>{" "}</Text>
          </Box>
        ),
        "LOW"
      ));
    }
  });

  return out;
}

export function renderStyledLine(spans: StyledSpan[], theme: ThemeTokens): React.ReactNode {
  return (
    <>
      {spans.map((p, idx) => {
        if (p.isCode) {
          return (
            <Text key={idx} color={theme.success} bold>
              {p.text}
            </Text>
          );
        }
        if (p.isBold) {
          return (
            <Text key={idx} color={theme.accent} bold>
              {p.text}
            </Text>
          );
        }

        const words = p.text.split(/(\s+)/);
        return (
          <Text key={idx} color={theme.text}>
            {words.map((w, wIdx) => {
              const trimmed = w.trim();
              const lower = trimmed.toLowerCase();

              // Positive outcomes
              if (["success", "successfully", "passed", "done", "ready", "active", "connected", "enabled", "completed", "✓"].includes(lower) || lower.startsWith("success")) {
                return <Text key={wIdx} color={theme.success} bold>{w}</Text>;
              }
              // Warnings / Risks
              if (["warning", "caution", "risk", "paused", "pending", "waiting", "attention", "◷", "always"].includes(lower)) {
                return <Text key={wIdx} color={theme.warning} bold>{w}</Text>;
              }
              // Failures
              if (["failed", "failure", "error", "critical", "emergency", "override", "disabled", "denied", "✗", "⨉"].includes(lower) || lower.startsWith("err")) {
                return <Text key={wIdx} color={theme.danger} bold>{w}</Text>;
              }
              // File paths, commands or alias indicators
              if (trimmed.includes(".") && (trimmed.endsWith(".ts") || trimmed.endsWith(".tsx") || trimmed.endsWith(".js") || trimmed.endsWith(".jsx") || trimmed.endsWith(".json") || trimmed.endsWith(".md") || trimmed.endsWith(".py") || trimmed.endsWith(".yaml") || trimmed.endsWith(".yml") || trimmed.includes("/") || trimmed.includes("\\") || trimmed.startsWith("$") || trimmed.startsWith("!"))) {
                return <Text key={wIdx} color={theme.accent} bold>{w}</Text>;
              }

              return w;
            })}
          </Text>
        );
      })}
    </>
  );
}

export function formatInlineText(lineText: string, theme: ThemeTokens): React.ReactNode {
  return renderStyledLine(parseInlineSpans(lineText), theme);
}

interface FormattedLinesCacheEntry {
  content: string;
  thought: string;
  streaming: boolean;
  expandedTui: boolean;
  /** Whether this message held the transcript focus highlight when cached. */
  focused: boolean;
  cols: number;
  themeBg: string;
  themeText: string;
  lines: FormattedLine[];
}

const formattedLinesCache = new Map<string, FormattedLinesCacheEntry>();

/**
 * Whether the model's thought block should render fully expanded.
 *
 * Two independent triggers, OR'd:
 * - Manual `ctrl+o` (`expandedTui`) pins the LAST message's thought open and keeps
 *   it open after the turn ends (history inspection).
 * - `autoExpandThinking` (flag) expands ANY message WHILE it is streaming and
 *   collapses it the instant the stream ends — the live-detail / idle-digest
 *   behaviour. The formatted-lines cache keys on `streaming`, so the true→false
 *   flip recomputes the (now collapsed) lines automatically; a new turn's stream
 *   re-expands. No new panel — this reuses the existing thought render path.
 */
export function resolveThoughtExpansion(
  expandedTui: boolean,
  isLastMessage: boolean,
  streaming: boolean,
  autoExpandThinking: boolean
): boolean {
  return (expandedTui && isLastMessage) || (autoExpandThinking && streaming);
}

interface ThoughtHeaderProps {
  showSpinner: boolean;
  shouldExpandThought: boolean;
  theme: ThemeTokens;
}

const ThoughtHeader = memo(function ThoughtHeader({ showSpinner, shouldExpandThought, theme }: ThoughtHeaderProps) {
  const tick = useTick(showSpinner, 120);
  const spinFrame = showSpinner ? frameAt(SPINNER_FRAMES, tick) + " " : "";
  return (
    <Text color={theme.accent}>
      {spinFrame}→ Thinking{shouldExpandThought ? "" : " [ctrl+o to view]"}
    </Text>
  );
});

export function shouldInjectSpacerBeforeSystemLine(line: string): boolean {
  const cleanLine = line.replace(/^[⚡◆\s]+/, "").trim();
  return (
    cleanLine.includes("Spawning specialist") ||
    cleanLine.includes("Running auto-verification") ||
    cleanLine.includes("Verification passed successfully") ||
    cleanLine.includes("Verification failed")
  );
}

export function isTraceText(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  
  // If it consists entirely of system activity lines
  const lines = trimmed.split("\n");
  const allSystem = lines.every(line => isSystemActivityLine(line));
  if (allSystem) return true;

  // Check for explicit cognition/planning indicators
  const lower = trimmed.toLowerCase();
  if (lower.startsWith("planner analysis") || lower.startsWith("cognition trace") || lower.startsWith("recovery reasoning") || lower.startsWith("thought:") || lower.startsWith("thinking:")) {
    return true;
  }

  return false;
}

interface LineMetrics {
  lineId: string;
  estimatedHeight: number;
  actualHeight?: number;
  lastMeasuredAt: number;
}
const lineMetricsCache = new Map<string, LineMetrics>();

interface StreamingCacheEntry {
  contentLength: number;
  cols: number;
  themeBg: string;
  themeText: string;
  expandedTui: boolean;
  lines: FormattedLine[];
}
const streamingCache = new Map<string, StreamingCacheEntry>();

export function getRenderPressure(messagesLength: number): {
  isMemoryStressed: boolean;
  isLagging: boolean;
  isQueueFlooded: boolean;
  pressureScore: number;
} {
  let isMemoryStressed = false;
  try {
    const mem = process.memoryUsage();
    isMemoryStressed = mem.heapUsed / mem.heapTotal > 0.8;
  } catch { }

  const lag = getLoopLag();
  const isLagging = lag > 100;
  const isQueueFlooded = messagesLength > 500;

  let score = 0;
  if (isMemoryStressed) score += 0.4;
  if (lag > 50) score += 0.3;
  if (lag > 150) score += 0.3;
  if (messagesLength > 300) score += 0.2;

  return {
    isMemoryStressed,
    isLagging,
    isQueueFlooded,
    pressureScore: Math.min(1.0, score)
  };
}

function extractTextFromNode(node: React.ReactNode): string {
  if (!node) return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) {
    return node.map(extractTextFromNode).join("");
  }
  if (React.isValidElement(node)) {
    const props = node.props as any;
    if (props && props.children) {
      return extractTextFromNode(props.children);
    }
  }
  return "";
}

export function estimateNodeHeight(element: React.ReactNode, cols: number): number {
  const text = extractTextFromNode(element);
  if (!text) return 1;
  const lines = text.split("\n");
  let totalHeight = 0;
  for (const line of lines) {
    const width = getStringWidth(line);
    totalHeight += Math.max(1, Math.ceil(width / cols));
  }
  return totalHeight;
}

export function estimateLineHeight(lineKey: string, element: React.ReactNode, cols: number): number {
  let entry = lineMetricsCache.get(lineKey);
  if (entry && entry.actualHeight !== undefined) {
    return entry.actualHeight;
  }
  const height = estimateNodeHeight(element, cols);
  lineMetricsCache.set(lineKey, {
    lineId: lineKey,
    estimatedHeight: height,
    actualHeight: height,
    lastMeasuredAt: Date.now()
  });
  return height;
}

function partitionStreamContent(content: string) {
  const lines = content.split("\n");
  const primaryTextLines: string[] = [];
  const traceLines: string[] = [];
  const codeLines: string[] = [];

  let inCodeBlock = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("```")) {
      inCodeBlock = !inCodeBlock;
      codeLines.push(line);
      continue;
    }

    if (inCodeBlock) {
      codeLines.push(line);
    } else if (isSystemActivityLine(line)) {
      traceLines.push(line);
    } else {
      primaryTextLines.push(line);
    }
  }

  // Trim trailing empty lines to prevent phantom blank rows in viewport
  while (primaryTextLines.length > 0 && primaryTextLines[primaryTextLines.length - 1]!.trim() === "") {
    primaryTextLines.pop();
  }
  // Trim leading empty lines to prevent phantom blank rows before content
  while (primaryTextLines.length > 0 && primaryTextLines[0]!.trim() === "") {
    primaryTextLines.shift();
  }

  // Collapse consecutive empty lines to max 1 (preserve paragraph breaks but kill excessive spacing)
  const compacted: string[] = [];
  let prevEmpty = false;
  for (const line of primaryTextLines) {
    const isEmpty = line.trim() === "";
    if (isEmpty && prevEmpty) continue; // skip consecutive empties
    compacted.push(line);
    prevEmpty = isEmpty;
  }

  return { primaryTextLines: compacted, traceLines, codeLines };
}

let lastColsValue = 0;
let lastThemeBg = "";
let lastThemeText = "";

export function calculateFormattedLines(
  messages: SessionMessage[],
  cols: number,
  theme: ThemeTokens,
  _latestAssistantId: string | null,
  subagents?: SubagentStatus[],
  loading?: boolean,
  expandedTui?: boolean,
  _tick?: number,
  goalActive?: boolean,
  focusedMessageId?: string | null,
  deadlineOptions?: {
    maxDuration?: number;
    startIndex?: number;
    existingLines?: FormattedLine[];
  }
): FormattedLine[] & {
  completed?: boolean;
  lastIndex?: number;
} {
  // Live-detail / idle-digest: expand the streaming message's thought while it is
  // thinking, collapse it when the stream ends (flag-gated; manual ctrl+o still
  // pins history open). One env read per render call, not per line.
  const autoExpandThinking = getRuntimeFlags().autoExpandThinking;
  if (cols !== lastColsValue || theme.bg !== lastThemeBg || theme.text !== lastThemeText) {
    formattedLinesCache.clear();
    streamingCache.clear();
    lineMetricsCache.clear();
    lastColsValue = cols;
    lastThemeBg = theme.bg;
    lastThemeText = theme.text;
  }

  linePool.reset();
  // Unified ordered activity timeline (opt-in). Constant per process, so it does
  // not need to be part of the per-message cache key.
  const useTimelineParts = getRuntimeFlags().timelineParts;
  const lines: FormattedLine[] = deadlineOptions?.existingLines ? [...deadlineOptions.existingLines] : [];
  const innerWidth = measureContentWidth(cols);

  const pressure = getRenderPressure(messages.length);
  if (pressure.isMemoryStressed && formattedLinesCache.size > 100) {
    formattedLinesCache.clear();
    streamingCache.clear();
    lineMetricsCache.clear();
  }

  // Active Memory Compact Flush: purge caches if heap usage exceeds 85% of limit
  try {
    const heapStats = v8.getHeapStatistics();
    if (heapStats.used_heap_size > 0.85 * heapStats.heap_size_limit) {
      formattedLinesCache.clear();
      streamingCache.clear();
      lineMetricsCache.clear();
    }
  } catch {}

  const tier = getDegradationTier(messages.length);
  if (tier >= 1) {
    if (lineMetricsCache.size > 200) {
      lineMetricsCache.clear();
    }
    if (formattedLinesCache.size > 5) {
      const keysToEvict = Array.from(formattedLinesCache.keys()).slice(0, formattedLinesCache.size - 5);
      for (const k of keysToEvict) {
        formattedLinesCache.delete(k);
      }
    }
  }

  const startIndex = deadlineOptions?.startIndex ?? 0;
  const maxDuration = deadlineOptions?.maxDuration ?? Infinity;
  const startTime = typeof performance !== "undefined" ? performance.now() : Date.now();
  let completed = true;
  let lastIndex = messages.length - 1;
  let dirtyRowsComputed = 0;

  for (let mIdx = startIndex; mIdx < messages.length; mIdx++) {
    if (mIdx !== startIndex && mIdx % 10 === 0) {
      const elapsed = (typeof performance !== "undefined" ? performance.now() : Date.now()) - startTime;
      if (elapsed > maxDuration) {
        completed = false;
        lastIndex = mIdx - 1;
        break;
      }
    }
    const m = messages[mIdx]!;
    const isLastMessage = mIdx === messages.length - 1;
    const isStreamingActive = isLastMessage && loading;
    // Transcript focus highlight (flag `transcriptNav`). Off → focusedMessageId is
    // null/undefined → always false → headers render via the legacy path
    // (byte-identical). Part of the cache key so moving focus re-renders both the
    // message that lost it and the one that gained it.
    const isFocused = !!focusedMessageId && m.id === focusedMessageId;

    if (!isStreamingActive) {
      const cached = formattedLinesCache.get(m.id);
      if (
        cached &&
        cached.content === m.content &&
        cached.thought === (m.thought || "") &&
        cached.streaming === m.streaming &&
        cached.expandedTui === !!expandedTui &&
        cached.focused === isFocused &&
        cached.cols === cols &&
        cached.themeBg === theme.bg &&
        cached.themeText === theme.text
      ) {
        // Cached lines render verbatim. Content is NEVER dropped based on
        // runtime pressure (lag/heap) — doing so made the user's own text
        // vanish and reappear as the loop got busy, corrupting the scroll
        // math and jittering the whole layout.
        lines.push(...cached.lines);
        continue;
      }
    }

    dirtyRowsComputed++;

    const isShellExecution = m.role === "system" && m.content.startsWith("SHELL_EXECUTION:");
    if (isShellExecution) {
      const rawText = m.content.slice("SHELL_EXECUTION:".length).trim();
      const firstNewLine = rawText.indexOf("\n");
      const cmdLine = firstNewLine !== -1 ? rawText.slice(0, firstNewLine).trim() : rawText;
      const outputText = firstNewLine !== -1 ? rawText.slice(firstNewLine + 1).trim() : "";

      const badgeInfo = getBadgeStyles("SHELL", theme);
      const messageLines: FormattedLine[] = [];

      messageLines.push(linePool.acquire(
        `${m.id}-shell-header`,
        (
          <Box marginLeft={2} flexDirection="row" alignItems="center">
            <Box marginRight={1}>
              <Text backgroundColor={badgeInfo.bg} color={badgeInfo.fg} bold>
                {` ${badgeInfo.icon} SHELL `}
              </Text>
            </Box>
            <Text color={theme.text} bold>Manual Command Execution</Text>
          </Box>
        ),
        "HIGH"
      ));

      const cleanCmd = cmdLine.startsWith("$ ") ? cmdLine.slice(2) : cmdLine;
      messageLines.push(linePool.acquire(
        `${m.id}-shell-cmd`,
        (
          <Box flexDirection="row" width={innerWidth}>
            <Text color={theme.accent}>│ </Text>
            <Text color={theme.accent} bold>❯ </Text>
            <Box flexGrow={1} overflow="hidden">
              <Text color={theme.text} bold>{cleanCmd}</Text>
            </Box>
          </Box>
        ),
        "HIGH"
      ));

      const outputLines = outputText ? outputText.split("\n") : [];
      const hasError = outputText.toLowerCase().includes("error") || outputText.toLowerCase().includes("failed");
      const isExitNonZero = outputText.includes("(exit") && !outputText.includes("(exit 0)");
      const isFailed = hasError || isExitNonZero;

      if ((expandedTui || isFailed) && outputLines.length > 0) {
        outputLines.forEach((outLine, oIdx) => {
          const wrapWidth = Math.max(4, innerWidth - 6);
          const wrappedOut = wrapText(outLine, wrapWidth);
          wrappedOut.forEach((wrappedLineText, wlIdx) => {
            messageLines.push(linePool.acquire(
                `${m.id}-shell-out-${oIdx}-${wlIdx}`,
                (
                  <Box flexDirection="row" width={innerWidth}>
                    <Text color={theme.accent}>│ </Text>
                    <Text color={theme.muted}>  │ </Text>
                    <Box flexGrow={1} overflow="hidden">
                      <Text color={isFailed ? theme.danger : theme.text} dimColor={!isFailed}>{wrappedLineText}</Text>
                    </Box>
                  </Box>
                ),
                isFailed ? "HIGH" : "MEDIUM"
            ));
          });
        });
      } else {
        const linesCount = outputLines.length;
        const statusChar = isFailed ? "✗" : "✓";
        const statusColor = isFailed ? theme.danger : theme.success;
        const summaryText = isFailed
          ? `Command failed with error · ${linesCount} lines of output`
          : `Command completed successfully · ${linesCount} lines of output`;

        messageLines.push(linePool.acquire(
          `${m.id}-shell-collapsed`,
          (
            <Box flexDirection="row" width={innerWidth}>
              <Text color={theme.accent}>│ </Text>
              <Text color={theme.muted}>  └─ </Text>
              <Text color={statusColor} bold>{statusChar} </Text>
              <Text color={theme.muted}>{summaryText} </Text>
              <Text color={theme.muted} dimColor>· [ctrl+o to expand]</Text>
            </Box>
          ),
          "MEDIUM"
        ));
      }

      if (!isLastMessage) {
        messageLines.push(linePool.acquire(
          `${m.id}-shell-spacer`,
          <Text>{" "}</Text>,
          "LOW"
        ));
      }

      lines.push(...messageLines);

      if (!isStreamingActive) {
        if (formattedLinesCache.size > 1000) {
          formattedLinesCache.clear();
        }
        formattedLinesCache.set(m.id, {
          content: m.content,
          thought: m.thought || "",
          streaming: !!m.streaming,
          expandedTui: !!expandedTui,
          focused: isFocused,
          cols,
          themeBg: theme.bg,
          themeText: theme.text,
          lines: messageLines.map(l => ({ key: l.key, element: l.element, priority: l.priority, isImmutable: l.isImmutable })),
        });
      }
      continue;
    }

    const messageLines: FormattedLine[] = [];
    const pushBodyLine = (element: React.ReactNode, keyStr: string, priority: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW" = "MEDIUM") => {
      messageLines.push(linePool.acquire(keyStr, element, priority));
    };

    const isSystem = m.role === "system";
    const isSubagent = isSystem && isSubagentNotice(m.content);
    const isThinkingOrExplore = isSystem && isThinkingOrExploreNotice(m.content);

    const badgeColor = isSubagent
      ? theme.accent
      : isThinkingOrExplore
        ? theme.warning
        : isSystem
          ? theme.muted
          : theme.success;

    const prefixColor = m.role === "user" ? theme.accent : badgeColor;

    // The focused message (transcript nav) gets a flat gutter (▎) in place of the
    // 2-column indent so the badge stays aligned; un-focused uses the original
    // marginLeft={2} box → byte-identical when nothing is focused.
    const headerBox = (badge: React.ReactNode) =>
      isFocused ? (
        <Box flexDirection="row">
          <Text color={theme.accent} bold>{"▎ "}</Text>
          {badge}
        </Box>
      ) : (
        <Box marginLeft={2}>{badge}</Box>
      );

    if (m.role === "user") {
      // Clean up planning/review/read-only prefixes from history view
      let cleanContent = m.content;
      const prefixes = [
        "[READ-ONLY MODE — answer questions only, do not edit files]",
        "[READ-ONLY MODE - answer questions only, do not edit files]",
        "[PLANNING MODE — Focus on architecture, design, and step-by-step implementation plan]",
        "[REVIEW MODE — Focus on systematic root cause analysis, debugging, and step-by-step fixes]",
      ];
      prefixes.forEach((pfx) => {
        if (cleanContent.startsWith(pfx)) {
          cleanContent = cleanContent.slice(pfx.length).trim();
        }
      });

      // 1. Header
      messageLines.push(linePool.acquire(
        `${m.id}-header`,
        headerBox(
          <Text color={theme.accent} bold>
            ● User
          </Text>
        ),
        "MEDIUM"
      ));

      // 2. Body lines
      const wrapWidth = Math.max(4, innerWidth - 2);
      const wrapped = wrapText(cleanContent, wrapWidth);
      wrapped.forEach((lineText: string, lIdx: number) => {
        pushBodyLine(
          (
            <Box flexDirection="row" width={innerWidth}>
              <Text color={theme.accent}>{"│ "}</Text>
              <Box flexGrow={1} overflow="hidden">
                <Text color={theme.text}>{lineText}</Text>
              </Box>
            </Box>
          ),
          `${m.id}-body-${lIdx}`
        );
      });

      // 3. Spacer
      if (!isLastMessage) {
        messageLines.push(linePool.acquire(
          `${m.id}-spacer`,
          <Text>{" "}</Text>,
          "MEDIUM"
        ));
      }
    } else { // assistant or system
      const badgeText = isSubagent
        ? "● Subagent"
        : isThinkingOrExplore
          ? "● Thinking"
          : isSystem
            ? "● System"
            : m.streaming
              ? "● Agent (writing)"
              : "● Agent";

      // 1. Header
      messageLines.push(linePool.acquire(
        `${m.id}-header`,
        headerBox(
          <Text color={badgeColor} bold={!isSystem || isSubagent || isThinkingOrExplore} dimColor={isSystem && !isSubagent && !isThinkingOrExplore}>
            {badgeText}
          </Text>
        ),
        "MEDIUM"
      ));

      // Render Thought block if present
      if (m.thought) {
        const showSpinner = !!(isLastMessage && loading);
        const shouldExpandThought = resolveThoughtExpansion(!!expandedTui, isLastMessage, !!m.streaming, autoExpandThinking);

        pushBodyLine(
          (
            <Box flexDirection="row" width={innerWidth}>
              <Text color={theme.muted}>│ </Text>
              <ThoughtHeader
                showSpinner={showSpinner}
                shouldExpandThought={shouldExpandThought}
                theme={theme}
              />
            </Box>
          ),
          `${m.id}-thought-start`
        );

        if (shouldExpandThought) {
          const wrapWidth = Math.max(4, innerWidth - 4);
          const wrappedThought = wrapText(m.thought.trim(), wrapWidth);

          wrappedThought.forEach((thoughtLineText: string, tIdx: number) => {
            pushBodyLine(
              (
                <Box flexDirection="row" width={innerWidth}>
                  <Text color={theme.muted}>│ </Text>
                  <Box marginLeft={2} flexGrow={1} overflow="hidden">
                    <Text color={theme.muted}>{thoughtLineText}</Text>
                  </Box>
                </Box>
              ),
              `${m.id}-thought-line-${tIdx}`
            );
          });

          pushBodyLine(
            (
              <Box flexDirection="row" width={innerWidth}>
                <Text color={theme.dimBorder}>
                  {"┄".repeat(Math.max(4, innerWidth - 2))}
                </Text>
              </Box>
            ),
            `${m.id}-thought-divider`
          );
        }
      }

      const cleanedContent = stripToolCalls(m.content);

      if (useTimelineParts && m.role === "assistant") {
        // Unified ordered timeline: one parser/renderer for both streaming and
        // final, so the SAME content never re-renders differently once the turn
        // ends, and tool/[SYSTEM:] activity stays in true order (rendered concise,
        // not dumped verbatim). Replaces the file-change summary + dual-parser
        // body for assistant messages; the thought block above is unchanged.
        messageLines.push(...renderConversationParts(
          parseConversationParts(cleanedContent),
          {
            mId: m.id,
            innerWidth,
            prefixColor,
            theme,
            isStreamingActive: !!isStreamingActive,
            tick: _tick || 0,
          }
        ));
      } else if (m.role === "assistant" && m.streaming) {
        const wrapWidth = Math.max(4, innerWidth - 2);

        let cached = streamingCache.get(m.id);
        let formatted: FormattedLine[] = [];

        if (
          cached &&
          cached.contentLength === cleanedContent.length &&
          cached.cols === cols &&
          cached.themeBg === theme.bg &&
          cached.themeText === theme.text &&
          cached.expandedTui === !!expandedTui
        ) {
          formatted = cached.lines;
        } else {
          formatted = [];
          const { primaryTextLines, traceLines, codeLines } = partitionStreamContent(cleanedContent);

          // 1. Render primary text lines
          let lineIdx = 0;
          primaryTextLines.forEach((lineText, idx) => {
            const wrapped = wrapText(lineText, wrapWidth);
            if (wrapped.length === 0) {
              formatted.push(linePool.acquire(
                `${m.id}-stream-primary-${lineIdx++}`,
                (
                  <Box flexDirection="row" width={innerWidth}>
                    <Text color={prefixColor}>│ </Text>
                    <Box flexGrow={1} overflow="hidden">
                      <Text color={theme.text}></Text>
                    </Box>
                  </Box>
                ),
                "HIGH"
              ));
            } else {
              wrapped.forEach((wLine, wlIdx) => {
                const isLast = idx === primaryTextLines.length - 1 && wlIdx === wrapped.length - 1;
                const hasNoTracesOrCode = traceLines.length === 0 && codeLines.length === 0;
                formatted.push(linePool.acquire(
                  `${m.id}-stream-primary-${lineIdx++}`,
                  (
                    <Box flexDirection="row" width={innerWidth}>
                      <Text color={prefixColor}>│ </Text>
                      <Box flexGrow={1} overflow="hidden">
                        <Text color={theme.text}>
                          {wLine}
                          {isStreamingActive && isLast && hasNoTracesOrCode ? "▊" : ""}
                        </Text>
                      </Box>
                    </Box>
                  ),
                  "HIGH"
                ));
              });
            }
          });

          // Spacer if we have both primary text and code/traces (skip when collapsed — compact layout)
          if (expandedTui && primaryTextLines.length > 0 && (codeLines.length > 0 || traceLines.length > 0)) {
            formatted.push(linePool.acquire(
              `${m.id}-stream-spacer-primary`,
              (
                <Box flexDirection="row" width={innerWidth}>
                  <Text color={prefixColor}>│ </Text>
                  <Text>{" "}</Text>
                </Box>
              ),
              "LOW"
            ));
          }

          // 2. Render code lines (if any)
          if (codeLines.length > 0) {
            const innerCodeLines = codeLines.filter(l => !l.trim().startsWith("```"));
            const maxLineNumWidth = String(innerCodeLines.length).length;
            const displayedLinesCount = expandedTui ? Math.min(innerCodeLines.length, 24) : Math.min(innerCodeLines.length, 12);

            formatted.push(linePool.acquire(
              `${m.id}-stream-code-header`,
              (
                <Box flexDirection="row" width={innerWidth}>
                  <Text color={prefixColor}>│ </Text>
                  <Text color={theme.accent} bold>  [Code Block]</Text>
                </Box>
              ),
              "HIGH"
            ));

            for (let lIdx = 0; lIdx < displayedLinesCount; lIdx++) {
              const lineText = innerCodeLines[lIdx]!;
              const lineNum = String(lIdx + 1).padStart(maxLineNumWidth, " ");
              const wrapWidthCode = Math.max(4, innerWidth - maxLineNumWidth - 8);
              const wrappedCode = wrapText(lineText, wrapWidthCode, { preserveIndent: true });

              wrappedCode.forEach((codeLineText: string, clIdx: number) => {
                formatted.push(linePool.acquire(
                  `${m.id}-stream-code-line-${lIdx}-${clIdx}`,
                  (
                    <Box flexDirection="row" width={innerWidth}>
                      <Text color={prefixColor}>│ </Text>
                      <Text color={theme.muted}>  {clIdx === 0 ? lineNum : " ".repeat(maxLineNumWidth)} │ </Text>
                      <Box flexGrow={1} overflow="hidden">
                        <Text color={theme.text} backgroundColor={theme.panel}>{codeLineText}</Text>
                      </Box>
                    </Box>
                  ),
                  "HIGH"
                ));
              });
            }

            if (innerCodeLines.length > displayedLinesCount) {
              formatted.push(linePool.acquire(
                `${m.id}-stream-code-truncated`,
                (
                  <Box flexDirection="row" width={innerWidth}>
                    <Text color={prefixColor}>│ </Text>
                    <Text color={theme.muted}>  {" ".repeat(maxLineNumWidth)} │ </Text>
                    <Text color={theme.muted} backgroundColor={theme.panel} dimColor>
                      ... ({innerCodeLines.length - displayedLinesCount} more lines remaining) [ctrl+o to collapse]
                    </Text>
                  </Box>
                ),
                "MEDIUM"
              ));
            }

            // Spacer after code block (skip when collapsed)
            if (expandedTui) {
              formatted.push(linePool.acquire(
                `${m.id}-stream-code-spacer`,
                (
                  <Box flexDirection="row" width={innerWidth}>
                    <Text color={prefixColor}>│ </Text>
                    <Text>{" "}</Text>
                  </Box>
                ),
                "LOW"
              ));
            }
          }

          // 3. Render trace lines (if any)
          if (traceLines.length > 0) {
            if (!expandedTui) {
              const lastLine = traceLines[traceLines.length - 1] || "";
              let traceLabel = "Planner analysis";
              if (lastLine.toLowerCase().includes("thought") || lastLine.toLowerCase().includes("cognition") || lastLine.toLowerCase().includes("reasoning")) {
                traceLabel = "Thinking";
              } else if (lastLine.toLowerCase().includes("tool") || lastLine.toLowerCase().includes("executing") || lastLine.toLowerCase().includes("spawning")) {
                traceLabel = "Tool execution";
              } else {
                traceLabel = "Planner analysis";
              }

              formatted.push(linePool.acquire(
                `${m.id}-stream-trace-collapsed-single`,
                (
                  <Box flexDirection="row" width={innerWidth}>
                    <Text color={prefixColor}>│ </Text>
                    <Text color={theme.muted}>  └─ </Text>
                    <Text color={theme.accent}>▶ </Text>
                    <Text color={theme.accent}>{traceLabel}</Text>
                  </Box>
                ),
                "HIGH"
              ));
            } else {
              formatted.push(linePool.acquire(
                `${m.id}-stream-traces-header`,
                (
                  <Box flexDirection="row" width={innerWidth}>
                    <Text color={prefixColor}>│ </Text>
                    <Text color={theme.accent}>  ▼ Activity</Text>
                  </Box>
                ),
                "HIGH"
              ));

              traceLines.forEach((line, idx) => {
                const isLast = idx === traceLines.length - 1;
                const bullet = isLast ? "└─ " : "├─ ";
                const isActive = !!isStreamingActive && isLast;
                formatted.push(linePool.acquire(
                  `${m.id}-stream-trace-${idx}`,
                  (
                    <Box flexDirection="row" width={innerWidth}>
                      <Text color={prefixColor}>│ </Text>
                      <Text color={theme.muted}>  │ {bullet}</Text>
                      <Box flexGrow={1} overflow="hidden">
                        {toConciseTelemetry(line, theme, isActive, _tick || 0)}
                      </Box>
                    </Box>
                  ),
                  "HIGH"
                ));
              });
            }
          }

          streamingCache.set(m.id, {
            contentLength: cleanedContent.length,
            cols,
            themeBg: theme.bg,
            themeText: theme.text,
            expandedTui: !!expandedTui,
            lines: formatted.map(l => ({ key: l.key, element: l.element, priority: l.priority, isImmutable: l.isImmutable }))
          });
        }

        messageLines.push(...formatted);
      } else {
        const blocks = parseAssistantContent(cleanedContent);

        // Structured file-change summary (flat lines — fits the line-pool, no
        // bordered card): show WHICH files this turn changed, read honestly from
        // the raw tool calls. Renders first in the body so it's immediately
        // scannable; the ⚡ tool lines (collapsed in traces) only say "edited".
        if (m.role === "assistant") {
          const fileChanges = extractFileChanges(m.content);
          fileChanges.forEach((fc, i) => {
            const verbColor =
              fc.verb === "delete" ? theme.danger
              : fc.verb === "write" ? theme.success
              : fc.verb === "rename" || fc.verb === "create dir" ? theme.accent
              : theme.warning;
            pushBodyLine(
              (
                <Box flexDirection="row" width={innerWidth}>
                  <Text color={prefixColor}>│ </Text>
                  <Text color={verbColor} bold>{fc.verb}</Text>
                  <Text color={theme.text} wrap="truncate"> {fc.path}</Text>
                </Box>
              ),
              `${m.id}-filechange-${i}`,
              "HIGH"
            );
          });
        }

        // Partition non-streaming blocks into Conversational, Code, and Traces
        const conversationalParagraphs: { blockIdx: number; text: string; isHeader: boolean }[] = [];
        const codeBlocks: AssistantBlock[] = [];
        const traceItems: (
          | { type: "thought" }
          | { type: "paragraph"; blockIdx: number; text: string; label: string }
          | { type: "action"; blockIdx: number; block: AssistantBlock }
        )[] = [];

        const shouldExpandThought = resolveThoughtExpansion(!!expandedTui, isLastMessage, !!m.streaming, autoExpandThinking);
        if (m.thought && !shouldExpandThought) {
          traceItems.push({ type: "thought" });
        }

        blocks.forEach((block, bIdx) => {
          if (block.type === "code") {
            codeBlocks.push(block);
          } else if (block.type === "action") {
            traceItems.push({ type: "action", blockIdx: bIdx, block });
          } else if (block.type === "text" && block.text) {
            const paragraphs = block.text.split("\n\n");
            paragraphs.forEach((p) => {
              const cleanP = p.trim();
              if (!cleanP) return;

              if (isTraceText(cleanP)) {
                let label = "Thinking";
                const lowerText = cleanP.toLowerCase();
                if (lowerText.includes("recovery") || lowerText.includes("revert") || lowerText.includes("healing") || lowerText.includes("rollback")) {
                  label = "Recovery reasoning";
                } else if (lowerText.includes("plan") || lowerText.includes("architecture") || lowerText.includes("implementation") || lowerText.includes("todo")) {
                  label = "Planner analysis";
                }
                traceItems.push({ type: "paragraph", blockIdx: bIdx, text: cleanP, label });
              } else {
                const isHeader = cleanP.startsWith("#");
                const cleanText = isHeader ? cleanP.replace(/^#+\s+/, "") : cleanP;
                conversationalParagraphs.push({ blockIdx: bIdx, text: cleanText, isHeader });
              }
            });
          }
        });

        // 1. Render Conversational Paragraphs
        const wrapWidth = Math.max(4, innerWidth - 2);
        conversationalParagraphs.forEach((para, pIdx) => {
          if (para.text === "---") {
            pushBodyLine(
              (
                <Box flexDirection="row" width={innerWidth}>
                  <Text color={prefixColor}>│ </Text>
                  <Text color={theme.dimBorder}>
                    {"─".repeat(Math.max(4, innerWidth - 2))}
                  </Text>
                </Box>
              ),
              `${m.id}-conv-para-${pIdx}-divider`
            );
            return;
          }

          const wrapped = wrapText(para.text, wrapWidth);
          wrapped.forEach((lineText, lIdx) => {
            pushBodyLine(
              (
                <Box flexDirection="row" width={innerWidth}>
                  <Text color={prefixColor}>│ </Text>
                  <Box flexGrow={1} overflow="hidden">
                    {para.isHeader ? (
                      <Text color={theme.accent} bold>{lineText}</Text>
                    ) : (
                      formatInlineText(lineText, theme)
                    )}
                  </Box>
                </Box>
              ),
              `${m.id}-conv-para-${pIdx}-line-${lIdx}`
            );
          });

          if (pIdx < conversationalParagraphs.length - 1) {
            pushBodyLine(
              (
                <Box flexDirection="row" width={innerWidth}>
                  <Text color={prefixColor}>│ </Text>
                  <Text>{" "}</Text>
                </Box>
              ),
              `${m.id}-conv-para-${pIdx}-spacer`,
              "LOW"
            );
          }
        });

        // 2. Render Code Blocks (if any)
        codeBlocks.forEach((block, bIdx) => {
          if (expandedTui) {
            pushBodyLine(
              (
                <Box flexDirection="row" width={innerWidth}>
                  <Text color={prefixColor}>│ </Text>
                  <Text>{" "}</Text>
                </Box>
              ),
              `${m.id}-code-block-pre-spacer-${bIdx}`,
              "LOW"
            );
          }

          const codeLines = block.code?.split("\n") ?? [];
          const maxLineNumWidth = String(codeLines.length).length;
          const displayedLinesCount = expandedTui ? Math.min(codeLines.length, 24) : Math.min(codeLines.length, 12);

          pushBodyLine(
            (
              <Box flexDirection="row" width={innerWidth}>
                <Text color={prefixColor}>│ </Text>
                <Text color={theme.accent} bold>  [Code Block]</Text>
              </Box>
            ),
            `${m.id}-code-block-${bIdx}-header`
          );

          for (let lIdx = 0; lIdx < displayedLinesCount; lIdx++) {
            const lineText = codeLines[lIdx]!;
            const lineNum = String(lIdx + 1).padStart(maxLineNumWidth, " ");
            const wrapWidthCode = Math.max(4, innerWidth - maxLineNumWidth - 8);
            const wrappedCode = wrapText(lineText, wrapWidthCode, { preserveIndent: true });

            wrappedCode.forEach((codeLineText: string, clIdx: number) => {
              pushBodyLine(
                (
                  <Box flexDirection="row" width={innerWidth}>
                    <Text color={prefixColor}>│ </Text>
                    <Text color={theme.muted}>  {clIdx === 0 ? lineNum : " ".repeat(maxLineNumWidth)} │ </Text>
                    <Box flexGrow={1} overflow="hidden">
                      <Text color={theme.text} backgroundColor={theme.panel}>{codeLineText}</Text>
                    </Box>
                  </Box>
                ),
                `${m.id}-code-block-${bIdx}-line-${lIdx}-${clIdx}`
              );
            });
          }

          if (codeLines.length > displayedLinesCount) {
            pushBodyLine(
              (
                <Box flexDirection="row" width={innerWidth}>
                  <Text color={prefixColor}>│ </Text>
                  <Text color={theme.muted}>  {" ".repeat(maxLineNumWidth)} │ </Text>
                  <Text color={theme.muted} backgroundColor={theme.panel} dimColor>
                    ... ({codeLines.length - displayedLinesCount} more lines remaining) [ctrl+o to collapse]
                  </Text>
                </Box>
              ),
              `${m.id}-code-block-${bIdx}-truncated`
            );
          }
        });

        // 3. Render Traces & Thoughts (if any)
        if (traceItems.length > 0) {
          if (expandedTui) {
            pushBodyLine(
              (
                <Box flexDirection="row" width={innerWidth}>
                  <Text color={prefixColor}>│ </Text>
                  <Text>{" "}</Text>
                </Box>
              ),
              `${m.id}-traces-pre-spacer`,
              "LOW"
            );
          }

          if (!expandedTui) {
            let traceLabel = "Planner analysis";
            if (traceItems.some(item => item.type === "thought")) {
              traceLabel = "Thinking";
            } else if (traceItems.some(item => item.type === "action")) {
              traceLabel = "Tool execution";
            } else {
              const paraItem = traceItems.find(item => item.type === "paragraph") as { label: string } | undefined;
              if (paraItem) {
                traceLabel = paraItem.label;
              }
            }

            pushBodyLine(
              (
                <Box flexDirection="row" width={innerWidth}>
                  <Text color={prefixColor}>│ </Text>
                  <Text color={theme.muted}>  └─ </Text>
                  <Text color={theme.accent}>▶ </Text>
                  <Text color={theme.accent}>{traceLabel}</Text>
                </Box>
              ),
              `${m.id}-traces-collapsed-single`,
              "MEDIUM"
            );
          } else {
            pushBodyLine(
              (
                <Box flexDirection="row" width={innerWidth}>
                  <Text color={prefixColor}>│ </Text>
                  <Text color={theme.accent}>  ▼ Activity</Text>
                </Box>
              ),
              `${m.id}-traces-header`,
              "HIGH"
            );

            traceItems.forEach((item, tIdx) => {
              const isLast = tIdx === traceItems.length - 1;
              const bullet = isLast ? "└─ " : "├─ ";

              if (item.type === "thought") {
                const wrapWidthThought = Math.max(4, innerWidth - 10);
                const wrappedThought = wrapText(m.thought!.trim(), wrapWidthThought);

                wrappedThought.forEach((thoughtLineText: string, thIdx: number) => {
                  pushBodyLine(
                    (
                      <Box flexDirection="row" width={innerWidth}>
                        <Text color={prefixColor}>│ </Text>
                        <Text color={theme.muted}>  │ {thIdx === 0 ? bullet : "   "}</Text>
                        <Box flexGrow={1} overflow="hidden">
                          <Text color={theme.muted}>{thoughtLineText}</Text>
                        </Box>
                      </Box>
                    ),
                    `${m.id}-trace-thought-line-${thIdx}`
                  );
                });
              } else if (item.type === "paragraph") {
                const rawLines = item.text.split("\n");
                rawLines.forEach((line, lineIdx) => {
                  const isSys = isSystemActivityLine(line);
                  if (isSys) {
                    pushBodyLine(
                      (
                        <Box flexDirection="row" width={innerWidth}>
                          <Text color={prefixColor}>│ </Text>
                          <Text color={theme.muted}>  │ {lineIdx === 0 ? bullet : "   "}</Text>
                          <Box flexGrow={1} overflow="hidden">
                            <SystemActivityLine line={line} theme={theme} isActive={false} expandedTui={true} />
                          </Box>
                        </Box>
                      ),
                      `${m.id}-trace-para-${tIdx}-sysline-${lineIdx}`
                    );
                  } else {
                    const wrapped = wrapText(line, Math.max(4, innerWidth - 10));
                    wrapped.forEach((wLine, wlIdx) => {
                      pushBodyLine(
                        (
                          <Box flexDirection="row" width={innerWidth}>
                            <Text color={prefixColor}>│ </Text>
                            <Text color={theme.muted}>  │ {lineIdx === 0 && wlIdx === 0 ? bullet : "   "}</Text>
                            <Box flexGrow={1} overflow="hidden">
                              <Text color={theme.muted} dimColor>{wLine}</Text>
                            </Box>
                          </Box>
                        ),
                        `${m.id}-trace-para-${tIdx}-line-${lineIdx}-${wlIdx}`
                      );
                    });
                  }
                });
              } else if (item.type === "action") {
                const block = item.block;
                const badgeInfo = getBadgeStyles(block.badge!, theme);

                pushBodyLine(
                  (
                    <Box flexDirection="row" width={innerWidth} alignItems="center">
                      <Text color={prefixColor}>│ </Text>
                      <Text color={theme.muted}>  │ {bullet}</Text>
                      <Box marginLeft={1} marginRight={1}>
                        <Text backgroundColor={badgeInfo.bg} color={badgeInfo.fg} bold>
                          {` ${badgeInfo.icon} ${block.badge} `}
                        </Text>
                      </Box>
                      <Box flexGrow={1} overflow="hidden">
                        <Text color={theme.text} bold>{block.description ?? ""}</Text>
                      </Box>
                    </Box>
                  ),
                  `${m.id}-trace-action-${tIdx}-header`
                );

                const subLines = block.subLines ?? [];
                subLines.forEach((sub, sIdx) => {
                  const cleanSub = sub.replace(/^\s*[└├│L\-□■]\s*/, "").replace(/^✓\s*/, "").trim();
                  let subPrefixChar = sIdx === subLines.length - 1 ? "└─ " : "├─ ";
                  let isChecklist = false;
                  let checkColor = theme.muted;

                  if (sub.trim().startsWith("□") || sub.trim().startsWith("- [ ]")) {
                    subPrefixChar = "□ ";
                    isChecklist = true;
                    checkColor = theme.muted;
                  } else if (sub.trim().startsWith("■") || sub.trim().startsWith("- [x]") || sub.trim().startsWith("- [/]")) {
                    subPrefixChar = sub.trim().startsWith("- [/]") ? "◷ " : "✓ ";
                    isChecklist = true;
                    checkColor = sub.trim().startsWith("- [/]") ? theme.warning : theme.success;
                  }

                  const wrappedSub = wrapText(cleanSub, Math.max(4, innerWidth - 11));
                  wrappedSub.forEach((subLineText: string, slIdx: number) => {
                    pushBodyLine(
                      (
                        <Box flexDirection="row" width={innerWidth}>
                          <Text color={prefixColor}>│ </Text>
                          <Text color={theme.muted}>  │   </Text>
                          {slIdx === 0 ? (
                            <Text color={isChecklist ? checkColor : theme.muted} bold={isChecklist}>
                              {subPrefixChar}
                            </Text>
                          ) : (
                            <Text color={theme.muted}>  </Text>
                          )}
                          <Box flexGrow={1} overflow="hidden">
                            {formatTechnicalSubLine(subLineText, theme)}
                          </Box>
                        </Box>
                      ),
                      `${m.id}-trace-action-${tIdx}-sub-${sIdx}-${slIdx}`
                    );
                  });
                });
              }

              if (tIdx < traceItems.length - 1) {
                pushBodyLine(
                  (
                    <Box flexDirection="row" width={innerWidth}>
                      <Text color={prefixColor}>│ </Text>
                      <Text color={theme.muted}>  │ </Text>
                    </Box>
                  ),
                  `${m.id}-trace-item-spacer-${tIdx}`,
                  "LOW"
                );
              }
            });
          }
        }
      }

      // 3. Spacer
      if (!isLastMessage) {
        messageLines.push(linePool.acquire(
          `${m.id}-spacer`,
          <Text>{" "}</Text>,
          "LOW"
        ));
      }
    }

    lines.push(...messageLines);

    if (!isStreamingActive) {
      if (formattedLinesCache.size > 1000) {
        formattedLinesCache.clear();
      }
      formattedLinesCache.set(m.id, {
        content: m.content,
        thought: m.thought || "",
        streaming: !!m.streaming,
        expandedTui: !!expandedTui,
        focused: isFocused,
        cols,
        themeBg: theme.bg,
        themeText: theme.text,
        lines: messageLines.map(l => ({ key: l.key, element: l.element, priority: l.priority, isImmutable: l.isImmutable })),
      });
    }
  }

  if (completed && !goalActive && subagents && subagents.length > 0) {
    const workerLifecycle = getRuntimeFlags().workerPanelLifecycle;
    const doneCount = subagents.filter((a) => a.status === "done").length;
    const errCount = subagents.filter((a) => a.status === "error").length;
    const runCount = subagents.filter((a) => a.status === "running").length;
    const queuedCount = subagents.filter((a) => a.status === "queued").length;
    const interruptedCount = subagents.filter((a) => a.status === "interrupted").length;

    // Smart collapse: once the turn is idle and no worker is still active, fold the
    // multi-row live panel into one terse summary line — the live detail mattered
    // while running, not as a permanent transcript fixture. Flag-gated; legacy
    // keeps the full always-on panel (byte-identical when off).
    const allTerminal = runCount === 0 && queuedCount === 0;
    if (workerLifecycle && !loading && allTerminal) {
      const parts: string[] = [];
      if (doneCount > 0) parts.push(`${doneCount} done`);
      if (errCount > 0) parts.push(`${errCount} failed`);
      if (interruptedCount > 0) parts.push(`${interruptedCount} stopped`);
      const summary = parts.length > 0 ? parts.join(" · ") : `${subagents.length} finished`;
      lines.push(linePool.acquire(
        "subagents-summary",
        (
          <Box flexDirection="row" marginLeft={2} marginTop={0}>
            <Text color={errCount > 0 ? theme.danger : theme.success}>
              {errCount > 0 ? LIFECYCLE_GLYPHS.error : LIFECYCLE_GLYPHS.done}{" "}
            </Text>
            <Text color={theme.muted}>
              Workers · {summary}
            </Text>
          </Box>
        ),
        "MEDIUM"
      ));
      lines.push(linePool.acquire(
        "subagents-divider-spacer",
        <Text>{" "}</Text>,
        "MEDIUM"
      ));
    } else {

    lines.push(linePool.acquire(
      "subagents-header",
      (
        <Box flexDirection="row" marginLeft={2} marginBottom={0} marginTop={0}>
          <Text color={theme.text} bold>
            Workers
          </Text>
          <Text color={theme.muted}>
            {"  "}{runCount} active
            {doneCount > 0 ? ` · ${doneCount} done` : ""}
            {queuedCount > 0 ? ` · ${queuedCount} queued` : ""}
            {errCount > 0 ? ` · ${errCount} failed` : ""}
            {interruptedCount > 0 ? ` · ${interruptedCount} stopped` : ""}
          </Text>
        </Box>
      ),
      "MEDIUM"
    ));

    const sortedSubagents = [...subagents].sort((a, b) => {
      const statusPriority = { running: 0, error: 1, interrupted: 2, done: 3, queued: 4 };
      const pA = statusPriority[a.status] ?? 5;
      const pB = statusPriority[b.status] ?? 5;
      if (pA !== pB) return pA - pB;
      return a.agentId.localeCompare(b.agentId);
    });

    const maxVisibleWorkers = 5;
    const needsCap = sortedSubagents.length > maxVisibleWorkers;
    const visibleSubagents = needsCap ? sortedSubagents.slice(0, maxVisibleWorkers) : sortedSubagents;

    visibleSubagents.forEach((agent) => {
      const isActive = agent.status === "running";
      const name = `worker.${agent.agentId}`;

      // Worker Status label & color
      let statusColor = theme.muted;
      if (agent.status === "done") statusColor = theme.success;
      else if (agent.status === "running") statusColor = theme.accent;
      else if (agent.status === "error") statusColor = theme.danger;
      else if (agent.status === "interrupted") statusColor = theme.warning;

      const elapsedSec = agent.elapsedMs !== undefined ? `${(agent.elapsedMs / 1000).toFixed(0)}s` : "";
      const timingInfo = elapsedSec ? ` | ${elapsedSec}` : "";
      const statusWord = agent.status === "interrupted" ? "stopped" : agent.status;
      const statusLabel = `[${statusWord}${timingInfo}]`;

      // Smart runtime view: show WHAT a running worker is doing right now on its
      // collapsed row (current action / phase, already sentence-case), so the
      // operator reads progress at a glance without expanding. Capped to keep the
      // row from blowing out the layout (same guard ToolActivity uses). Only for
      // running workers — a terminal row stays terse on just its status. Gated by
      // workerPanelLifecycle; legacy row is byte-identical when off.
      const rawPhase = isActive ? (agent.phase ?? "").trim() : "";
      const phaseText =
        workerLifecycle && rawPhase
          ? rawPhase.length > 40
            ? `${rawPhase.slice(0, 39)}…`
            : rawPhase
          : "";

      if (!expandedTui) {
        // Collapsed Workers
        lines.push(linePool.acquire(
          `subagent-row-${agent.agentId}`,
          (
            <Box flexDirection="row" marginLeft={2} marginTop={0}>
              <Text color={theme.accent}>▶ </Text>
              <Text color={theme.text} bold={isActive} wrap="truncate">
                {name}{" "}
              </Text>
              <Text color={statusColor} bold={isActive}>
                {statusLabel}{" "}
              </Text>
              {phaseText ? (
                <Text color={theme.muted} wrap="truncate">
                  → {phaseText}{" "}
                </Text>
              ) : null}
              <Text color={theme.muted} dimColor>
                [ctrl+o]
              </Text>
            </Box>
          ),
          "MEDIUM"
        ));
      } else {
        // Expanded Workers
        lines.push(linePool.acquire(
          `subagent-row-${agent.agentId}`,
          (
            <Box flexDirection="row" marginLeft={2} marginTop={0}>
              <Text color={theme.accent}>▼ </Text>
              <Text color={theme.accent} bold wrap="truncate">
                {name}{" "}
              </Text>
              <Text color={statusColor} bold>
                {statusLabel}
              </Text>
            </Box>
          ),
          "MEDIUM"
        ));

        if (agent.steps && agent.steps.length > 0) {
          const visibleSteps = agent.steps;
          const stepsCount = visibleSteps.length;
          visibleSteps.forEach((step, sIdx) => {
            const isLastStep = sIdx === stepsCount - 1;
            const treeConnector = isLastStep ? "   └─ " : "   ├─ ";

            lines.push(linePool.acquire(
              `subagent-${agent.agentId}-step-${sIdx}`,
              (
                <SubagentStepRow
                  treeConnector={treeConnector}
                  status={step.status}
                  label={step.label}
                  theme={theme}
                />
              ),
              "MEDIUM"
            ));
          });
        }
      }
    });

    if (needsCap) {
      lines.push(linePool.acquire(
        "subagents-scroll-indicator",
        (
          <Box marginLeft={4} marginTop={0}>
            <Text color={theme.muted} italic>
              ▲ +{sortedSubagents.length - maxVisibleWorkers} more workers
            </Text>
          </Box>
        ),
        "MEDIUM"
      ));
    }

    if (loading) {
      lines.push(linePool.acquire(
        "subagents-footer",
        (
          <Box marginLeft={2} marginTop={0}>
            <Text color={theme.muted} dimColor>
              esc pause · ctrl+c safe stop
            </Text>
          </Box>
        ),
        "MEDIUM"
      ));
    }

    lines.push(linePool.acquire(
      "subagents-divider-spacer",
      <Text>{" "}</Text>,
      "MEDIUM"
    ));
    }
  }

  const finalLines = lines as FormattedLine[] & { completed?: boolean; lastIndex?: number; dirtyRowsComputed?: number };
  finalLines.completed = completed;
  finalLines.lastIndex = lastIndex;
  finalLines.dirtyRowsComputed = dirtyRowsComputed;
  return finalLines;
}

// TOOL_ALIASES and tool operations extracted to utils/conversation/tool-labels

let violationCount = 0;
let isLevel3Announced = false;

/**
 * Frame/violation telemetry to `.agency/tui-diagnostics.log` is OFF by default.
 * It was written from the render path via synchronous appendFileSync (~1Hz) — a
 * blocking disk hitch that contributed to the very jitter it was measuring, and
 * a side effect inside a useMemo (impure). Enable with AGENCY_TUI_DIAGNOSTICS=1
 * only when debugging a rendering issue.
 */
function diagnosticsEnabled(): boolean {
  return process.env.AGENCY_TUI_DIAGNOSTICS === "1" || process.env.AGENCY_TUI_DIAGNOSTICS === "true";
}

function rotateTelemetryLogIfNeeded(logFile: string) {
  try {
    if (!fs.existsSync(logFile)) return;
    const stats = fs.statSync(logFile);
    if (stats.size > 1024 * 1024) { // 1MB
      const content = fs.readFileSync(logFile, "utf8");
      const lines = content.split("\n");
      if (lines.length > 1000) {
        const keptLines = lines.slice(-1000).join("\n");
        fs.writeFileSync(logFile, keptLines, "utf8");
      }
    }
  } catch {}
}

function logInvariantViolation(invariant: string, correction: string) {
  if (!diagnosticsEnabled()) return;
  violationCount++;
  const logDir = path.join(process.cwd(), ".agency");
  const logFile = path.join(logDir, "tui-diagnostics.log");

  try {
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }
    const logMsg = `[${new Date().toISOString()}] INVARIANT VIOLATION: ${invariant} - Self-Correction Action: ${correction} - Total Violations: ${violationCount}\n`;
    fs.appendFileSync(logFile, logMsg, "utf8");
    rotateTelemetryLogIfNeeded(logFile);
  } catch (err) {
    console.error("Failed to write to tui-diagnostics.log:", err);
  }
}

let lastLoggedFrameTime = 0;
let lastFrameTimestamp = typeof performance !== "undefined" ? performance.now() : Date.now();
const framePacingDeltas: number[] = [];

function traceFrameTimeline(
  messagesCount: number,
  totalLinesCount: number,
  visibleLinesCount: number,
  latencyMs: number,
  violationType = "NONE",
  reconciliationDuration = 0,
  dirtyRowsComputed = 0
) {
  if (!diagnosticsEnabled()) return;
  const now = Date.now();
  const lag = getLoopLag();
  
  // Adaptive Diagnostic Sampling: rate-limit log writes based on thread pressure
  let logInterval = 1000; // default 1Hz
  if (typeof process !== "undefined" && process.env.VITEST) {
    logInterval = 0; // Disable rate-limiting in tests for deterministic verification
  } else if (lag > 200) {
    logInterval = 10000;  // 10s sample interval under extreme pressure
  } else if (lag > 100) {
    logInterval = 5000;   // 5s sample interval under high pressure
  }

  // Calculate frame pacing delta and running variance
  const timeNow = typeof performance !== "undefined" ? performance.now() : Date.now();
  const frameDelta = timeNow - lastFrameTimestamp;
  lastFrameTimestamp = timeNow;
  framePacingDeltas.push(frameDelta);
  if (framePacingDeltas.length > 50) framePacingDeltas.shift();
  
  const avgDelta = framePacingDeltas.reduce((a, b) => a + b, 0) / framePacingDeltas.length;
  const variance = framePacingDeltas.reduce((a, b) => a + Math.pow(b - avgDelta, 2), 0) / framePacingDeltas.length;

  if (now - lastLoggedFrameTime < logInterval) return;
  lastLoggedFrameTime = now;

  const logDir = path.join(process.cwd(), ".agency");
  const logFile = path.join(logDir, "tui-diagnostics.log");

  try {
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }
    const heapUsed = typeof process !== "undefined" ? (process.memoryUsage().heapUsed / 1024 / 1024).toFixed(1) : "0.0";
    const logMsg = `[${new Date().toISOString()}] FRAME_COMMIT - Latency: ${latencyMs.toFixed(1)}ms - Jitter: ${variance.toFixed(1)}ms^2 - Heap: ${heapUsed}MB - Messages: ${messagesCount} - TotalLines: ${totalLinesCount} - VisibleLines: ${visibleLinesCount} - DirtyRows: ${dirtyRowsComputed} - Violations: ${violationType} - RecCost: ${reconciliationDuration.toFixed(1)}ms - Lag: ${lag}ms\n`;
    fs.appendFileSync(logFile, logMsg, "utf8");
    rotateTelemetryLogIfNeeded(logFile);
  } catch {}
}



export interface ConversationProps {
  theme: ThemeTokens;
  messages: SessionMessage[];
  loading?: boolean;
  viewportHeight?: number;
  scrollOffset?: number;
  cols?: number;
  project?: string;
  modelName?: string;
  agentMode?: string;
  indexing?: boolean;
  indexReady?: boolean;
  themeId?: string;
  noProvider?: boolean;
  subagents?: SubagentStatus[];
  expandedTui?: boolean;
  goalActive?: boolean;
  /** Id of the message holding the transcript-nav focus highlight (flag `transcriptNav`). */
  focusedMessageId?: string | null;
}

export const Conversation = memo(
  function Conversation({
    theme,
    messages,
    loading = false,
    viewportHeight = 100,
    scrollOffset = 0,
    cols = 80,
    project,
    modelName,
    agentMode,
    indexing,
    indexReady,
    themeId,
    noProvider = false,
    subagents,
    expandedTui = false,
    goalActive = false,
    focusedMessageId = null,
  }: ConversationProps) {
    const degradationTier = getDegradationTier(messages.length);
    const survivalModeActive = degradationTier === 3;

    const messagesToProcess = useMemo(() => {
      if (survivalModeActive) {
        return messages.slice(-15);
      }
      return messages;
    }, [messages, survivalModeActive]);

    const latestAssistantId = useMemo(() => {
      const msgs = messagesToProcess;
      for (let i = msgs.length - 1; i >= 0; i--) {
        if (msgs[i]?.role === "assistant" && !msgs[i]?.streaming) {
          return msgs[i]!.id;
        }
      }
      return null;
    }, [messagesToProcess]);

    const isSmallSession = messagesToProcess.length <= 10000;

    const [linesState, setLinesState] = useState<{
      lines: FormattedLine[];
      lastIndex: number;
      completed: boolean;
      messages: SessionMessage[];
    } | null>(null);

    const allLines = useMemo(() => {
      const msgs = messagesToProcess;
      if (isSmallSession) {
        return calculateFormattedLines(msgs, cols, theme, latestAssistantId, subagents, loading, expandedTui, undefined, goalActive, focusedMessageId);
      }
      if (linesState && linesState.messages === msgs && linesState.completed) {
        return linesState.lines;
      }
      // Quick synchronous first pass
      const initialChunk = calculateFormattedLines(
        msgs,
        cols,
        theme,
        latestAssistantId,
        subagents,
        loading,
        expandedTui,
        undefined,
        goalActive,
        focusedMessageId,
        { maxDuration: 12, startIndex: 0 }
      );
      return initialChunk;
    }, [messagesToProcess, cols, theme, latestAssistantId, subagents, loading, expandedTui, goalActive, focusedMessageId, isSmallSession, linesState]);

    useEffect(() => {
      if (isSmallSession) {
        setLinesState(null);
        return;
      }

      let isCancelled = false;
      const msgs = messagesToProcess;

      const next = (startIndex: number, currentLines: FormattedLine[]) => {
        if (isCancelled) return;

        const timer = globalThis.setImmediate
          ? globalThis.setImmediate(() => {
              if (isCancelled) return;
              const chunk = calculateFormattedLines(
                msgs,
                cols,
                theme,
                latestAssistantId,
                subagents,
                loading,
                expandedTui,
                undefined,
                goalActive,
                focusedMessageId,
                {
                  maxDuration: 12,
                  startIndex,
                  existingLines: currentLines
                }
              );

              if (chunk.completed) {
                setLinesState({
                  lines: chunk,
                  lastIndex: msgs.length - 1,
                  completed: true,
                  messages: msgs
                });
              } else {
                setLinesState({
                  lines: chunk,
                  lastIndex: chunk.lastIndex ?? startIndex,
                  completed: false,
                  messages: msgs
                });
                next((chunk.lastIndex ?? startIndex) + 1, chunk);
              }
            })
          : globalThis.setTimeout(() => {
              if (isCancelled) return;
              const chunk = calculateFormattedLines(
                msgs,
                cols,
                theme,
                latestAssistantId,
                subagents,
                loading,
                expandedTui,
                undefined,
                goalActive,
                focusedMessageId,
                {
                  maxDuration: 12,
                  startIndex,
                  existingLines: currentLines
                }
              );

              if (chunk.completed) {
                setLinesState({
                  lines: chunk,
                  lastIndex: msgs.length - 1,
                  completed: true,
                  messages: msgs
                });
              } else {
                setLinesState({
                  lines: chunk,
                  lastIndex: chunk.lastIndex ?? startIndex,
                  completed: false,
                  messages: msgs
                });
                next((chunk.lastIndex ?? startIndex) + 1, chunk);
              }
            }, 0);

        return () => {
          if (globalThis.clearImmediate) {
            globalThis.clearImmediate(timer as any);
          } else {
            globalThis.clearTimeout(timer as any);
          }
        };
      };

      const initialCompleted = (allLines as any).completed !== false;
      if (!initialCompleted) {
        const lastIdx = (allLines as any).lastIndex ?? 0;
        const cleanup = next(lastIdx + 1, allLines);
        return () => {
          isCancelled = true;
          if (cleanup) cleanup();
        };
      } else {
        setLinesState({
          lines: allLines,
          lastIndex: msgs.length - 1,
          completed: true,
          messages: msgs
        });
      }
    }, [messagesToProcess, cols, theme, latestAssistantId, subagents, loading, expandedTui, goalActive, focusedMessageId, isSmallSession, allLines]);

    const innerWidth = useMemo(() => measureContentWidth(cols), [cols]);



    useEffect(() => {
      if (degradationTier === 3) {
        if (!isLevel3Announced) {
          writeRawStdout(`\r\n\x1b[31m▲ SYSTEM IN SURVIVAL MODE (Lag: ${getLoopLag()}ms) ▲\x1b[0m\r\n`);
          isLevel3Announced = true;
        }
      } else {
        if (isLevel3Announced && getLoopLag() < 50) {
          writeRawStdout(`\r\n\x1b[32m✓ RECOVERED FROM SURVIVAL MODE\x1b[0m\r\n`);
          isLevel3Announced = false;
        }
      }
    }, [degradationTier]);

    const { visibleLines, showAbove, showBelow, aboveCount, belowCount, scrollPercent, showScrollIndicator } = useMemo(() => {
      const startTime = typeof performance !== "undefined" ? performance.now() : Date.now();

      // Mathematically perfect scroll containment - every row has height 1
      const totalEstimatedHeight = allLines.length;

      // Fixed scroll indicator space allocation
      const isScrollActive = !survivalModeActive && totalEstimatedHeight > viewportHeight;
      const lockedViewportHeight = isScrollActive ? viewportHeight - 2 : viewportHeight;

      let correctedScrollOffset = scrollOffset;
      const maxScroll = Math.max(0, totalEstimatedHeight - lockedViewportHeight);
      if (scrollOffset < 0 || scrollOffset > maxScroll) {
        correctedScrollOffset = Math.max(0, Math.min(scrollOffset, maxScroll));
      }

      const showScrollIndicator = isScrollActive;

      const startLine = survivalModeActive ? 0 : correctedScrollOffset;
      const endLine = survivalModeActive ? allLines.length : Math.min(allLines.length, startLine + lockedViewportHeight);

      const visibleLines = allLines.slice(startLine, endLine);
      const aboveCount = startLine;
      const belowCount = Math.max(0, allLines.length - endLine);
      const scrollPercent = allLines.length > 0 ? Math.round((endLine / allLines.length) * 100) : 100;

      // Invariant 4: NO_DUPLICATE_VISIBLE_ROWS check & correction
      const keys = new Set<string>();
      let hasDuplicateKeys = false;
      for (const line of visibleLines) {
        if (keys.has(line.key)) {
          hasDuplicateKeys = true;
          break;
        }
        keys.add(line.key);
      }
      if (hasDuplicateKeys) {
        const uniqueVisibleLines: FormattedLine[] = [];
        const seen = new Set<string>();
        visibleLines.forEach((line, i) => {
          if (!seen.has(line.key)) {
            seen.add(line.key);
            uniqueVisibleLines.push(line);
          } else {
            // Deterministic position-based suffix so a deduped row keeps a
            // STABLE key across renders. Math.random() changed the key every
            // frame, forcing React to remount (and flicker) the row.
            uniqueVisibleLines.push({ ...line, key: `${line.key}-dup${i}` });
          }
        });
        logInvariantViolation("NO_DUPLICATE_VISIBLE_ROWS", "Appended deterministic suffixes to duplicate keys.");
        visibleVisibleLinesWorkaround(visibleLines, uniqueVisibleLines);
      }

      const endTime = typeof performance !== "undefined" ? performance.now() : Date.now();
      const latency = endTime - startTime;
      // Render latency / violations are recorded for diagnostics but are NEVER
      // used to drop into survival mode. Collapsing the conversation to the
      // last 15 messages because a single FRAME was slow destroyed scrollback
      // reactively — a prime cause of the vanishing history + jitter. Survival
      // mode is now reserved for the deterministic huge-session bound only.

      let violationType = "NONE";
      if (hasDuplicateKeys) violationType = "NO_DUPLICATE_VISIBLE_ROWS";

      traceFrameTimeline(
        messagesToProcess.length,
        allLines.length,
        visibleLines.length,
        latency,
        violationType,
        latency,
        (allLines as any).dirtyRowsComputed || 0
      );

      return {
        visibleLines,
        showAbove: startLine > 0,
        showBelow: endLine < allLines.length,
        aboveCount,
        belowCount,
        scrollPercent,
        showScrollIndicator
      };
    }, [allLines, scrollOffset, viewportHeight, cols, messagesToProcess, survivalModeActive]);

    const hasDialogue = messagesToProcess.some(
      (m) => m.role === "user" || m.role === "assistant"
    );

    if (!hasDialogue) {
      return (
        <EmptyChat
          theme={theme}
          project={project}
          modelName={modelName}
          agentMode={agentMode}
          indexing={indexing}
          indexReady={indexReady}
          themeId={themeId}
          noProvider={noProvider}
          height={viewportHeight}
        />
      );
    }

    // Calculate exact rendered height to prevent void stretching
    const renderedHeight = (() => {
      let h = visibleLines.length;
      if (showScrollIndicator && showAbove && aboveCount > 0) h += 1;
      if (showScrollIndicator && showBelow && belowCount > 0) h += 1;
      if (survivalModeActive) h += 2; // 1 text + 1 marginBottom
      // In survival mode, render all lines unclamped (bypasses viewport scroll clipping)
      return survivalModeActive ? h : Math.min(h, viewportHeight);
    })();

    return (
      <Box flexDirection="column" width={cols} height={renderedHeight}>
        {survivalModeActive && (
          <Box marginLeft={2} marginBottom={1}>
            <Text color={theme.danger} bold>▲ SYSTEM IN SURVIVAL MODE (Lag: {getLoopLag()}ms) ▲</Text>
          </Box>
        )}
        {showScrollIndicator && showAbove && aboveCount > 0 && (
          <Box height={1} flexDirection="row" justifyContent="space-between" width={innerWidth}>
            <Text color={theme.muted} dimColor>
              ↑ {aboveCount} line{aboveCount !== 1 ? "s" : ""} above
            </Text>
            <Text color={theme.dimBorder} dimColor>
              {scrollPercent}%
            </Text>
          </Box>
        )}
        {visibleLines.map((line) => (
          <Box key={line.key} overflow="hidden">
            {line.element}
          </Box>
        ))}
        {showScrollIndicator && showBelow && belowCount > 0 && (
          <Box height={1} flexDirection="row" justifyContent="center" width={innerWidth}>
            <Text color={theme.muted} dimColor>
              ↓ {belowCount} more line{belowCount !== 1 ? "s" : ""}
            </Text>
          </Box>
        )}
      </Box>
    );
  },
  (prevProps, nextProps) => {
    if (prevProps.cols !== nextProps.cols) return false;
    if (prevProps.viewportHeight !== nextProps.viewportHeight) return false;
    if (prevProps.scrollOffset !== nextProps.scrollOffset) return false;
    if (prevProps.loading !== nextProps.loading) return false;
    if (prevProps.expandedTui !== nextProps.expandedTui) return false;
    if (prevProps.goalActive !== nextProps.goalActive) return false;
    if (prevProps.focusedMessageId !== nextProps.focusedMessageId) return false;
    if (prevProps.indexing !== nextProps.indexing) return false;
    if (prevProps.indexReady !== nextProps.indexReady) return false;
    if (prevProps.themeId !== nextProps.themeId) return false;
    if (prevProps.noProvider !== nextProps.noProvider) return false;
    if (prevProps.project !== nextProps.project) return false;
    if (prevProps.modelName !== nextProps.modelName) return false;
    if (prevProps.agentMode !== nextProps.agentMode) return false;
    if (prevProps.theme !== nextProps.theme) return false;

    if (prevProps.messages !== nextProps.messages) {
      if (prevProps.messages.length !== nextProps.messages.length) return false;
      for (let i = 0; i < prevProps.messages.length; i++) {
        const m1 = prevProps.messages[i]!;
        const m2 = nextProps.messages[i]!;
        if (
          m1.id !== m2.id ||
          m1.content !== m2.content ||
          m1.thought !== m2.thought ||
          m1.streaming !== m2.streaming ||
          m1.role !== m2.role
        ) {
          return false;
        }
      }
    }

    if (prevProps.subagents !== nextProps.subagents) {
      if (!prevProps.subagents || !nextProps.subagents) return false;
      if (prevProps.subagents.length !== nextProps.subagents.length) return false;
      for (let i = 0; i < prevProps.subagents.length; i++) {
        const s1 = prevProps.subagents[i]!;
        const s2 = nextProps.subagents[i]!;
        if (
          s1.agentId !== s2.agentId ||
          s1.status !== s2.status ||
          s1.phase !== s2.phase ||
          s1.result !== s2.result
        ) {
          return false;
        }
        if ((s1.steps?.length ?? 0) !== (s2.steps?.length ?? 0)) return false;
        if (s1.steps && s2.steps) {
          for (let j = 0; j < s1.steps.length; j++) {
            if (s1.steps[j]!.status !== s2.steps[j]!.status || s1.steps[j]!.label !== s2.steps[j]!.label) {
              return false;
            }
          }
        }
      }
    }

    return true;
  }
);

function visibleVisibleLinesWorkaround(visibleLines: FormattedLine[], uniqueVisibleLines: FormattedLine[]) {
  visibleLines.splice(0, visibleLines.length, ...uniqueVisibleLines);
}
