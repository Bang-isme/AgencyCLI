import { useRef, useEffect, useCallback } from "react";
import { useInput } from "ink";
import type { ThemeTokens } from "../themes/registry.js";
import type { SubagentStatus } from "../state/subagent-status.js";
import { calculateFormattedLines, getMaxScrollOffset } from "../components/Conversation.js";
import { getDegradationTier } from "../terminal/screen.js";
import type { SessionMessage } from "../state/messages.js";
import { applyTextInput } from "./useTextInput.js";
import {
  type EditBuffer,
  type History,
  clampCursor,
  moveLeft,
  moveRight,
  moveWordLeft,
  moveWordRight,
  deleteWordBackward,
  editFromInput,
  recordEdit,
  undo,
  redo,
} from "../utils/text-buffer.js";
import { nextMode } from "../state/agent-modes.js";
import { saveTuiConfig } from "../config/tui-config.js";
export interface OverlayStates {
  connect: boolean;
  models: boolean;
  skills: boolean;
  review: boolean;
  status: boolean;
  plugins: boolean;
  variant: boolean;
  mcp: boolean;
  agents: boolean;
  resume: boolean;
  project: boolean;
  help: boolean;
  route: boolean;
}

export interface UseKeyboardHandlersOptions {
  // Pass-through states to avoid Temporal Dead Zone (TDZ) in App.tsx calculations
  overlays: OverlayStates;
  setOverlays: React.Dispatch<React.SetStateAction<OverlayStates>>;
  expandedTui: boolean;
  setExpandedTui: React.Dispatch<React.SetStateAction<boolean>>;
  scrollOffset: number;
  setScrollOffset: React.Dispatch<React.SetStateAction<number>>;
  activeSubagentId: string | null;
  setActiveSubagentId: React.Dispatch<React.SetStateAction<string | null>>;
  userHasScrolledUpRef: React.MutableRefObject<boolean>;

  // Contextual states and triggers
  phase: "splash" | "welcome" | "main";
  setPhase: (phase: "splash" | "welcome" | "main") => void;
  loading: boolean;
  goalActive: boolean;
  indexing: boolean;
  handleCancelOrAbort: () => boolean;
  safeExit: () => void;
  subagents: SubagentStatus[];
  conversationHeight: number;
  virtualLinesCount: number;
  buffer: string;
  setBuffer: React.Dispatch<React.SetStateAction<string>>;
  // Cursor-editing (flag `composerCursorEdit`). When off, the legacy
  // append-only `applyTextInput` path runs unchanged (byte-identical).
  composerCursorEdit: boolean;
  setCursorPos: React.Dispatch<React.SetStateAction<number>>;
  editBufRef: React.MutableRefObject<EditBuffer>;
  editHistoryRef: React.MutableRefObject<History>;
  internalEditRef: React.MutableRefObject<boolean>;
  slashActive: any;
  slashSuggestions: any[];
  atActive: any;
  atSuggestions: any[];
  welcomeIndex: number;
  setWelcomeIndex: React.Dispatch<React.SetStateAction<number>>;
  handleWelcomeAction: (idx: number) => void;
  pendingApproval: any;
  clearApproval: (decision: "approve" | "deny") => void;
  autoApproveRef: React.MutableRefObject<boolean>;
  messagesToProcess: SessionMessage[];
  composerWidth: number;
  theme: ThemeTokens;
  latestAssistantId: string | null;

  // Text interaction handlers
  setAgentMode: React.Dispatch<React.SetStateAction<any>>;
  handleSubmit: () => Promise<void>;

  // Goal runner configuration
  goalRunnerViewMode: "flat" | "boxy";
  setGoalRunnerViewMode: React.Dispatch<React.SetStateAction<"flat" | "boxy">>;
  config: any;

  // Overlay state helpers passed from App.tsx
  closeAllOverlays: () => void;
  setOverlayOpen: (key: keyof OverlayStates, open: boolean) => void;
  toggleOverlay: (key: keyof OverlayStates) => void;
  overlayActive: boolean;
}

export function useKeyboardHandlers(options: UseKeyboardHandlersOptions) {
  const optionsRef = useRef(options);
  useEffect(() => {
    optionsRef.current = options;
  });

  // Main Ink useInput key interceptor
  useInput(
    useCallback((input, key) => {
      const {
        expandedTui: _expandedTui,
        setExpandedTui,
        setScrollOffset,
        activeSubagentId,
        setActiveSubagentId,
        userHasScrolledUpRef,
        phase,
        loading,
        goalActive,
        indexing,
        handleCancelOrAbort,
        safeExit,
        subagents,
        conversationHeight,
        virtualLinesCount,
        buffer,
        setBuffer,
        composerCursorEdit,
        setCursorPos,
        editBufRef,
        editHistoryRef,
        internalEditRef,
        slashActive,
        slashSuggestions,
        atActive,
        atSuggestions,
        welcomeIndex,
        setWelcomeIndex,
        handleWelcomeAction,
        pendingApproval,
        clearApproval,
        autoApproveRef,
        messagesToProcess,
        composerWidth,
        theme,
        latestAssistantId,
        setAgentMode,
        handleSubmit,
        goalRunnerViewMode,
        setGoalRunnerViewMode,
        config,
        closeAllOverlays,
        setOverlayOpen,
        overlayActive,
      } = optionsRef.current;
    // ── Subagent panel navigation ──
    if (activeSubagentId !== null) {
      if (key.upArrow) {
        setActiveSubagentId(null);
        return;
      }
      if (key.leftArrow) {
        const idx = subagents.findIndex((s) => s.agentId === activeSubagentId);
        if (idx > 0) {
          setActiveSubagentId(subagents[idx - 1]!.agentId);
        } else if (subagents.length > 0) {
          setActiveSubagentId(subagents[subagents.length - 1]!.agentId);
        }
        return;
      }
      if (key.rightArrow) {
        const idx = subagents.findIndex((s) => s.agentId === activeSubagentId);
        if (idx !== -1 && idx < subagents.length - 1) {
          setActiveSubagentId(subagents[idx + 1]!.agentId);
        } else if (subagents.length > 0) {
          setActiveSubagentId(subagents[0]!.agentId);
        }
        return;
      }
      if (key.escape) {
        setActiveSubagentId(null);
        return;
      }
      return;
    }

    if (key.ctrl && input === "x" && subagents.length > 0) {
      setActiveSubagentId(subagents[0]!.agentId);
      return;
    }

    // ── Global shortcuts (always available) ──
    if (key.ctrl && input === "o") {
      setExpandedTui((prev) => {
        const nextVal = !prev;
        const prevLinesCount = calculateFormattedLines(
          messagesToProcess,
          composerWidth,
          theme,
          latestAssistantId,
          subagents,
          loading,
          prev,
          undefined,
          goalActive
        ).length;

        const nextLinesCount = calculateFormattedLines(
          messagesToProcess,
          composerWidth,
          theme,
          latestAssistantId,
          subagents,
          loading,
          nextVal,
          undefined,
          goalActive
        ).length;

        const delta = nextLinesCount - prevLinesCount;
        if (userHasScrolledUpRef.current) {
          setScrollOffset((current) => Math.max(0, current + delta));
        }
        return nextVal;
      });
      return;
    }

    if (key.ctrl && input === "c") {
      const active = loading || goalActive || indexing;
      if (active) {
        handleCancelOrAbort();
        return;
      }
      safeExit();
      return;
    }

    if (key.ctrl && input === "q") {
      safeExit();
      return;
    }

    if (phase === "splash") {
      return;
    }

    // ── Overlay guard: yield ALL input to overlay components ──
    // When any overlay with its own useInput is active, this global handler
    // must not process keystrokes to avoid conflicts. Overlays handle their
    // own Escape, Enter, arrow keys, and text input internally.
    if (overlayActive) {
      return;
    }

    const pickerActive =
      (slashActive && slashSuggestions.length > 0) ||
      (atActive && atSuggestions.length > 0);

    if (pickerActive && (key.upArrow || key.downArrow || key.tab || input === "\t")) {
      return;
    }

    if (phase === "welcome") {
      if (key.upArrow) {
        setWelcomeIndex((i) => Math.max(0, i - 1));
        return;
      }
      if (key.downArrow) {
        setWelcomeIndex((i) => Math.min(2, i + 1));
        return;
      }
      if (key.return) {
        handleWelcomeAction(welcomeIndex);
        return;
      }
      if (key.escape) {
        safeExit();
        return;
      }
      return;
    }

    if (indexing) {
      if (key.escape) {
        handleCancelOrAbort();
        return;
      }
    }

    // ── Help overlay toggle ──
    if (((key.ctrl && input === "h") || (input === "?" && buffer.length === 0))) {
      closeAllOverlays();
      setOverlayOpen("help", true);
      return;
    }

    // ── Scroll handlers ──
    if (!pendingApproval && !pickerActive) {
      if (key.pageUp || (key.ctrl && key.upArrow)) {
        setScrollOffset((offset) => {
          const amount = key.pageUp ? Math.max(2, conversationHeight - 2) : 3;
          const next = Math.max(0, offset - amount);
          if (next < offset) {
            userHasScrolledUpRef.current = true;
          }
          return next;
        });
        return;
      }
      if (key.pageDown || (key.ctrl && key.downArrow)) {
        setScrollOffset((offset) => {
          const amount = key.pageDown ? Math.max(2, conversationHeight - 2) : 3;
          const maxOffset = getMaxScrollOffset(
            virtualLinesCount,
            conversationHeight,
            getDegradationTier(messagesToProcess.length) === 3
          );
          const next = Math.min(maxOffset, offset + amount);
          if (next >= maxOffset) {
            userHasScrolledUpRef.current = false;
          }
          return next;
        });
        return;
      }
    }

    if (!pendingApproval && !pickerActive && (buffer.length === 0 || loading)) {
      if (key.upArrow) {
        setScrollOffset((offset) => {
          const next = Math.max(0, offset - 1);
          if (next < offset) {
            userHasScrolledUpRef.current = true;
          }
          return next;
        });
        return;
      }
      if (key.downArrow) {
        setScrollOffset((offset) => {
          const maxOffset = getMaxScrollOffset(
            virtualLinesCount,
            conversationHeight,
            getDegradationTier(messagesToProcess.length) === 3
          );
          const next = Math.min(maxOffset, offset + 1);
          if (next >= maxOffset) {
            userHasScrolledUpRef.current = false;
          }
          return next;
        });
        return;
      }
    }

    if (pendingApproval) {
      if (input === "y") {
        clearApproval("approve");
        return;
      }
      if (input === "a") {
        autoApproveRef.current = true;
        clearApproval("approve");
        return;
      }
      if (input === "n") {
        clearApproval("deny");
        return;
      }
      return;
    }

    if (goalActive) {
      if ((key.tab || input === "\t") && !pickerActive) {
        const nextMode = goalRunnerViewMode === "flat" ? "boxy" : "flat";
        setGoalRunnerViewMode(nextMode);
        saveTuiConfig({
          ...config,
          goalRunnerViewMode: nextMode,
        });
        return;
      }
      if (key.escape && !pickerActive) {
        handleCancelOrAbort();
        return;
      }
    }

    // ── Escape to cancel active operations ──
    if (key.escape) {
      handleCancelOrAbort();
      return;
    }

    // Tab to cycle agent mode (when buffer is empty and no autocomplete active)
    if ((key.tab || input === "\t") && buffer.length === 0 && !slashActive && !atActive) {
      setAgentMode((m: any) => nextMode(m));
      return;
    }

    // Handle Submit
    if (key.return && input.length === 1) {
      void handleSubmit();
      return;
    }

    // ── Cursor-aware composer editing (flag on) ──
    if (composerCursorEdit) {
      const cur: EditBuffer = {
        text: editBufRef.current.text,
        cursor: clampCursor(editBufRef.current.text, editBufRef.current.cursor),
      };

      // Move the caret only (text unchanged): no history entry, no buffer write.
      const navTo = (cursor: number) => {
        editBufRef.current = { text: cur.text, cursor };
        setCursorPos(cursor);
      };
      // Apply a restored buffer from undo/redo.
      const restore = (next: EditBuffer) => {
        editBufRef.current = next;
        internalEditRef.current = true;
        setBuffer(next.text);
        setCursorPos(next.cursor);
      };
      // Apply an edit: record undo state, write buffer + caret.
      const apply = (next: EditBuffer, kind: "insert" | "delete", boundary: boolean) => {
        if (next.text === cur.text) {
          if (next.cursor !== cur.cursor) navTo(next.cursor);
          return;
        }
        editHistoryRef.current = recordEdit(editHistoryRef.current, cur, kind, boundary);
        editBufRef.current = next;
        internalEditRef.current = true;
        setBuffer(next.text);
        setCursorPos(next.cursor);
      };

      // Caret navigation (Left/Right, Ctrl+←/→ word, Ctrl+A/Ctrl+E line ends).
      if (key.leftArrow) { navTo((key.ctrl ? moveWordLeft : moveLeft)(cur).cursor); return; }
      if (key.rightArrow) { navTo((key.ctrl ? moveWordRight : moveRight)(cur).cursor); return; }
      if (key.ctrl && input === "a") { navTo(0); return; }
      if (key.ctrl && input === "e") { navTo(cur.text.length); return; }

      // Undo / redo.
      if (key.ctrl && input === "z") {
        const r = undo(editHistoryRef.current, cur);
        if (r) { editHistoryRef.current = r.hist; restore(r.buffer); }
        return;
      }
      if (key.ctrl && input === "y") {
        const r = redo(editHistoryRef.current, cur);
        if (r) { editHistoryRef.current = r.hist; restore(r.buffer); }
        return;
      }

      // Delete word backward (Ctrl+W).
      if (key.ctrl && input === "w") { apply(deleteWordBackward(cur), "delete", true); return; }

      // Insert / Backspace / forward-Delete at the caret.
      const edit = editFromInput(input, key, cur);
      if (edit) { apply(edit.buffer, edit.kind, edit.boundary); return; }
      // Unhandled key in cursor mode: ignore (do NOT fall through to the
      // append-only path, which would desync the caret).
      return;
    }

    if (applyTextInput(input, key, setBuffer)) return;
  }, [])
  );
}
