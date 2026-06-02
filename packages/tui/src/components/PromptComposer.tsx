import { memo, useEffect, useState, useMemo } from "react";
import { Box, Text } from "ink";
import fs from "node:fs";
import path from "node:path";
import type { ThemeTokens } from "../themes/registry.js";
import { BlinkCursor } from "./AnimatedText.js";
import type { AgentMode } from "../state/agent-modes.js";
import { useTerminalLayout } from "../layout/TerminalLayoutProvider.js";
import { extractPathCandidates, shouldShowAttachmentChip, wrapText, type ResolvedPath } from "../utils/text.js";
import { clampCursor } from "../utils/text-buffer.js";

/** Zero-width-safe marker for the caret position inside the wrapped display text. */
const CARET_SENTINEL = "\u0000";

// Micro-cache to prevent duplicate disk reads
const pathCache = new Map<string, ResolvedPath>();

async function resolvePathDetails(candidate: string, projectRoot: string): Promise<ResolvedPath> {
  // Strip '@' if present
  const cleanPath = candidate.startsWith("@") ? candidate.slice(1) : candidate;
  
  let targetPath = cleanPath;
  if (!path.isAbsolute(cleanPath)) {
    targetPath = path.resolve(projectRoot, cleanPath);
  }
  
  try {
    const stats = await fs.promises.stat(targetPath);
    if (stats.isDirectory()) {
      try {
        const files = await fs.promises.readdir(targetPath);
        return { type: "dir", detail: `${files.length} files` };
      } catch {
        return { type: "dir", detail: "directory" };
      }
    } else if (stats.isFile()) {
      const sizeKb = (stats.size / 1024).toFixed(1);
      const ext = path.extname(targetPath).toLowerCase();
      const imgExtensions = [".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".bmp", ".ico"];
      if (imgExtensions.includes(ext)) {
        return { type: "img", detail: `${sizeKb} KB` };
      } else {
        return { type: "doc", detail: `${sizeKb} KB` };
      }
    }
  } catch {
    // Treat as error / not found
  }
  return { type: "err", detail: "NOT FOUND" };
}

export interface PromptComposerProps {
  theme: ThemeTokens;
  value: string;
  placeholder?: string;
  disabled?: boolean;
  focused?: boolean;
  agentMode?: AgentMode;
  modelName?: string;
  budgetMode?: string;
  thinkingLabel?: string;
  /** Skip rendering the border (when wrapped by an outer anchor frame) */
  noBorder?: boolean;
  project?: string;
  /**
   * Caret offset into `value`. When provided (cursor-editing mode), the block
   * cursor renders at this position instead of being pinned to the end. Omit for
   * the legacy append-only composer (caret at the end).
   */
  cursorPos?: number;
}

export function getComposerModeColor(mode: AgentMode, theme: ThemeTokens): string {
  switch (mode) {
    case "agent":
      return theme.accent;
    case "plan":
      return theme.warning;
    case "debug":
      return theme.danger;
    case "ask":
      return theme.success;
    default:
      return theme.accent;
  }
}

export const PromptComposer = memo(function PromptComposer({
  theme,
  value,
  placeholder = "Ask anything…",
  disabled = false,
  focused = true,
  agentMode = "agent",
  modelName: _modelName,
  budgetMode: _budgetMode,
  thinkingLabel: _thinkingLabel,
  noBorder = false,
  project,
  cursorPos,
}: PromptComposerProps) {
  const { composerWidth, composerInnerWidth } = useTerminalLayout();
  const isPlaceholder = value.length === 0;
  const showCursor = !disabled && focused;
  // Cursor-editing mode: render the caret at `cursorPos` (sentinel-marked inside
  // the wrapped text). Legacy mode (cursorPos undefined) keeps the end-pinned
  // block cursor. Disabled/blurred → no caret either way (matches legacy).
  const useCaret = showCursor && cursorPos != null;
  const caretOffset = useCaret ? clampCursor(value, cursorPos!) : 0;
  const modeColor = getComposerModeColor(agentMode, theme);
  const borderColor = focused && !disabled ? modeColor : theme.border;
  const hintWidth = 18;

  const [resolvedPaths, setResolvedPaths] = useState<Record<string, ResolvedPath>>({});

  // 1. Extract candidate paths
  const candidates = useMemo(() => extractPathCandidates(value), [value]);

  useEffect(() => {
    if (candidates.length === 0) {
      setResolvedPaths({});
      return;
    }

    let active = true;
    const projectRoot = project ?? process.cwd();

    // Debounce the file checks by 100ms
    const timer = setTimeout(async () => {
      const nextResolved: Record<string, ResolvedPath> = {};
      
      for (const candidate of candidates) {
        const cacheKey = `${projectRoot}:${candidate}`;
        if (pathCache.has(cacheKey)) {
          nextResolved[candidate] = pathCache.get(cacheKey)!;
          continue;
        }

        const details = await resolvePathDetails(candidate, projectRoot);
        pathCache.set(cacheKey, details);
        nextResolved[candidate] = details;
      }

      if (active) {
        setResolvedPaths(nextResolved);
      }
    }, 100);

    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [candidates, project]);

  // When noBorder is true, this component is wrapped inside an outer bordered box with paddingX(1).
  // We must fit within the inner bounds (composerInnerWidth) to prevent layout overflows.
  const outerWidth = noBorder ? composerInnerWidth : composerWidth;

  // 2. Multiline wrap calculation
  const padding = 2; // single borders
  const cursorPrefix = 2; // "❯ "
  const innerWidth = composerInnerWidth - padding - cursorPrefix;

  // In caret mode, splice a sentinel at the caret so the wrap places it on the
  // correct visual line/column; the renderer swaps it for the block cursor.
  const displayValue = useCaret
    ? value.slice(0, caretOffset) + CARET_SENTINEL + value.slice(caretOffset)
    : value;

  const wrappedLines: string[] = [];
  const rawLines = displayValue.split("\n");
  for (let i = 0; i < rawLines.length; i++) {
    const rawLine = rawLines[i]!;
    if (i === 0) {
      const wrapped = wrapText(rawLine, Math.max(5, innerWidth));
      wrappedLines.push(...wrapped);
    } else {
      const wrapped = wrapText(rawLine, Math.max(5, innerWidth + cursorPrefix));
      wrappedLines.push(...wrapped);
    }
  }

  const MAX_LINES = 6;
  const isTruncated = wrappedLines.length > MAX_LINES;
  const hiddenLinesCount = isTruncated ? wrappedLines.length - MAX_LINES : 0;
  const visibleLines = isTruncated ? wrappedLines.slice(-MAX_LINES) : wrappedLines;

  // 3. Render functions
  const renderAttachments = () => {
    if (candidates.length === 0) return null;

    // Only chip a candidate that is an explicit "@"-mention or a bare token that
    // actually resolves on disk. Pasted prose (stack frames, hostnames, URLs)
    // never resolves and must not render a fabricated red "NOT FOUND" badge.
    const visible = candidates.filter((c) => shouldShowAttachmentChip(c, resolvedPaths[c]));
    if (visible.length === 0) return null;

    return (
      <Box flexDirection="row" flexWrap="wrap" marginBottom={1} width="100%">
        {visible.map((candidate) => {
          const resolved = resolvedPaths[candidate]!;
          const filename = candidate.split(/[/\\]/).pop() || candidate;
          
          let prefixStr = "DOC";
          let badgeColor = theme.accent;

          if (resolved.type === "img") {
            prefixStr = "IMG";
            badgeColor = theme.accent;
          } else if (resolved.type === "dir") {
            prefixStr = "DIR";
            badgeColor = theme.accent;
          } else if (resolved.type === "err") {
            prefixStr = "ERR";
            badgeColor = theme.danger;
          }

          return (
            <Box
              key={candidate}
              borderStyle="single"
              borderColor={badgeColor}
              paddingX={1}
              marginRight={1}
              marginBottom={0}
            >
              <Text color={badgeColor}>{prefixStr}: {filename} ({resolved.detail})</Text>
            </Box>
          );
        })}
      </Box>
    );
  };

  const renderScrollIndicator = () => {
    if (!isTruncated) return null;

    return (
      <Box
        borderStyle="single"
        borderColor={theme.warning}
        paddingX={1}
        marginBottom={1}
        width="100%"
      >
        <Text color={theme.warning}>▲ +{hiddenLinesCount} lines scrollable above</Text>
      </Box>
    );
  };

  const renderTextContent = () => {
    if (isPlaceholder) {
      return (
        <Text color={theme.muted} dimColor>
          {placeholder}
        </Text>
      );
    }

    return (
      <Box flexDirection="column">
        {visibleLines.map((line, idx) => {
          const isFirstLine = idx === 0 && !isTruncated;
          const prefix = isFirstLine ? (
            <Text color={focused && !disabled ? modeColor : theme.muted}>❯ </Text>
          ) : (
            (idx === 0 && isTruncated) ? "" : "  "
          );
          // Caret mode: render the line split around the sentinel so the block
          // cursor sits exactly at the caret column.
          const sentIdx = useCaret ? line.indexOf(CARET_SENTINEL) : -1;
          if (sentIdx !== -1) {
            return (
              <Text key={idx} color={disabled ? theme.muted : theme.text}>
                {prefix}
                {line.slice(0, sentIdx)}
                <BlinkCursor active />
                {line.slice(sentIdx + CARET_SENTINEL.length)}
              </Text>
            );
          }
          return (
            <Text key={idx} color={disabled ? theme.muted : theme.text}>
              {prefix}
              {line}
              {!useCaret && showCursor && idx === visibleLines.length - 1 ? <BlinkCursor active /> : null}
            </Text>
          );
        })}
      </Box>
    );
  };

  return (
    <Box flexDirection="column" width={outerWidth} overflow="hidden">
      <Box
        borderStyle={noBorder ? undefined : "single"}
        borderColor={noBorder ? undefined : borderColor}
        paddingX={noBorder ? 0 : 1}
        flexDirection="column"
        width={outerWidth}
        overflow="hidden"
      >
        {renderAttachments()}
        {renderScrollIndicator()}

        <Box flexDirection="row" width={noBorder ? "100%" : composerInnerWidth} overflow="hidden">
          <Box flexGrow={1} width={composerInnerWidth - 2} overflow="hidden">
            {renderTextContent()}
          </Box>
          {isPlaceholder && !disabled ? (
            <Box flexShrink={0} width={hintWidth}>
              <Text color={theme.muted} dimColor wrap="truncate">
                @ files · / cmds
              </Text>
            </Box>
          ) : null}
        </Box>
      </Box>

      {isPlaceholder && !disabled ? (
        <Box width={outerWidth} justifyContent="flex-end" overflow="hidden">
          <Text color={theme.muted} dimColor wrap="truncate">
            tab modes · ? help
          </Text>
        </Box>
      ) : null}
    </Box>
  );
});
