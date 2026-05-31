import { useRef, useEffect, useCallback } from "react";
import { useInput } from "ink";
import type { ThemeTokens } from "../themes/registry.js";
import type { SubagentStatus } from "../components/SubagentPanel.js";
import { calculateFormattedLines, getMaxScrollOffset } from "../components/Conversation.js";
import { getDegradationTier } from "../terminal/screen.js";
import type { SessionMessage } from "../state/messages.js";
import { applyTextInput } from "./useTextInput.js";
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
  disclosureCycle: () => void;
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
        disclosureCycle,
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

    // Ctrl+D to cycle progressive disclosure level (Default → Advanced → Expert)
    if (key.ctrl && input === "d" && buffer.length === 0) {
      disclosureCycle();
      return;
    }

    // Handle Submit
    if (key.return && input.length === 1) {
      void handleSubmit();
      return;
    }

    if (applyTextInput(input, key, setBuffer)) return;
  }, [])
  );
}
