import React, { useRef, useEffect, useCallback } from "react";
import { Box, Text, useInput } from "ink";
import type { ThemeTokens } from "../themes/registry.js";
import type { SessionSummary } from "../sessions/store.js";
import { useTerminalLayout } from "../layout/TerminalLayoutProvider.js";
import { panelWidth } from "../layout/terminal-layout.js";

export interface SessionPickerProps {
  theme: ThemeTokens;
  sessions: SessionSummary[];
  index: number;
  setIndex: React.Dispatch<React.SetStateAction<number>>;
  deletingId?: string | null;
  setDeletingId: React.Dispatch<React.SetStateAction<string | null>>;
  onSelect: (session: SessionSummary) => void;
  onClose: () => void;
  onDelete?: (id: string) => void;
}

function timeAgo(ms: number): string {
  const diff = Date.now() - ms;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return "yesterday";
  return `${days}d ago`;
}

export function SessionPicker({
  theme,
  sessions,
  index,
  setIndex,
  deletingId,
  setDeletingId,
  onSelect,
  onClose,
  onDelete,
}: SessionPickerProps) {
  const safe = sessions.length === 0 ? 0 : Math.min(index, sessions.length - 1);

  const stateRef = useRef({
    sessions,
    safe,
    deletingId,
    onClose,
    onDelete,
    onSelect,
  });

  useEffect(() => {
    stateRef.current = {
      sessions,
      safe,
      deletingId,
      onClose,
      onDelete,
      onSelect,
    };
  });

  useInput(
    useCallback((input, key) => {
      const { sessions, safe, deletingId, onClose, onDelete, onSelect } = stateRef.current;
      if (key.escape) {
        if (deletingId) {
          setDeletingId(null);
        } else {
          onClose();
        }
        return;
      }
      if (key.upArrow || input === "k") {
        setDeletingId(null);
        setIndex((i) => (i === 0 ? sessions.length - 1 : i - 1));
        return;
      }
      if (key.downArrow || input === "j") {
        setDeletingId(null);
        setIndex((i) => (i === sessions.length - 1 ? 0 : i + 1));
        return;
      }
      if (key.ctrl && input === "d") {
        const s = sessions[safe];
        if (s) {
          if (deletingId === s.id) {
            onDelete?.(s.id);
          } else {
            setDeletingId(s.id);
          }
        }
        return;
      }
      if (key.return) {
        const s = sessions[safe];
        if (s) onSelect(s);
      }
    }, [])
  );

  const { cols } = useTerminalLayout();
  const overlayWidth = panelWidth(cols, 72, 40);
  const innerWidth = overlayWidth - 4;
  const dividerStr = "─".repeat(Math.max(0, innerWidth));

  const msgColW = innerWidth >= 50 ? 10 : 8;
  const timeColW = innerWidth >= 50 ? 12 : 0;

  if (sessions.length === 0) {
    return (
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor={theme.accent}
        paddingX={2}
        paddingY={1}
        width={overlayWidth}
      >
        <Text color={theme.muted} wrap="truncate">No saved sessions to resume.</Text>
        <Text color={theme.muted} dimColor wrap="truncate">
          Esc to close
        </Text>
      </Box>
    );
  }

  const MAX_VISIBLE_SESSIONS = 6;
  let start = 0;
  if (sessions.length > MAX_VISIBLE_SESSIONS) {
    start = Math.max(0, Math.min(safe - Math.floor(MAX_VISIBLE_SESSIONS / 2), sessions.length - MAX_VISIBLE_SESSIONS));
  }
  const visibleSessions = sessions.slice(start, start + MAX_VISIBLE_SESSIONS);

  const scrollUpHint = start > 0 ? ` (▲ ${start} above)` : "";
  const scrollDownHint = start + MAX_VISIBLE_SESSIONS < sessions.length ? ` (▼ ${sessions.length - start - MAX_VISIBLE_SESSIONS} below)` : "";

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={theme.accent}
      paddingX={2}
      paddingY={1}
      width={overlayWidth}
    >
      <Text color={theme.text} bold wrap="truncate">
        ↺ Resume Session{sessions.length > MAX_VISIBLE_SESSIONS ? ` (${safe + 1}/${sessions.length})${scrollUpHint}` : ""}
      </Text>
      <Text color={theme.dimBorder}>{dividerStr}</Text>
      {start > 0 && (
        <Box height={1} overflow="hidden">
          <Text color={theme.muted} dimColor>    ... and {start} more sessions above</Text>
        </Box>
      )}
      <Box flexDirection="column" marginY={0} overflow="hidden">
        {visibleSessions.map((s, i) => {
          const realIdx = start + i;
          const selected = realIdx === safe;
          const isDeleting = s.id === deletingId;
          const preview = isDeleting
            ? (innerWidth >= 55 ? "[■ PRESS CTRL+D AGAIN TO CONFIRM DELETE]" : "[■ Ctrl+d confirm delete]")
            : s.firstUserMessage
              ? s.firstUserMessage
              : "empty session";
            const arrowStr = selected ? "▸  " : "   ";
            const msgsStr = `${s.messageCount} msgs`.padEnd(msgColW) + " ";
            const timeStr = timeColW > 0 ? timeAgo(s.updatedAt).padEnd(timeColW) + " " : "";

            return (
              <Box key={s.id} overflow="hidden">
                <Text wrap="wrap">
                  <Text color={selected ? theme.accent : theme.muted}>
                    {arrowStr}
                  </Text>
                  <Text color={selected ? theme.accent : theme.muted}>
                    {msgsStr}
                  </Text>
                  {timeColW > 0 && (
                    <Text color={theme.muted} dimColor={!selected}>
                      {timeStr}
                    </Text>
                  )}
                  <Text color={isDeleting ? theme.danger : (selected ? theme.text : theme.muted)} dimColor={!selected && !isDeleting} bold={isDeleting}>
                    {preview}
                  </Text>
                </Text>
              </Box>
            );
        })}
      </Box>
      {start + MAX_VISIBLE_SESSIONS < sessions.length && (
        <Box height={1} overflow="hidden">
          <Text color={theme.muted} dimColor>    ... and {sessions.length - start - MAX_VISIBLE_SESSIONS} more sessions below</Text>
        </Box>
      )}
      <Text color={theme.dimBorder}>{dividerStr}</Text>
      <Text color={theme.muted} dimColor wrap="truncate">
        {innerWidth >= 55 ? `↑↓ navigate · Enter resume · Ctrl+d delete · Esc cancel${scrollDownHint}` : `↑↓:nav · Enter:ok · Ctrl+d:del · Esc:esc${scrollDownHint}`}
      </Text>
    </Box>
  );
}
