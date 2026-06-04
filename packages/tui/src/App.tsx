import { useState, useCallback, useMemo, useRef, useEffect, memo } from "react";
import { Box, useApp, Text } from "ink";
import { resolve as resolvePath } from "node:path";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  fuzzySearchFiles,
  resolveSkillsRoot,
  runChatTurnWithVerify,
  toPresentationTurn,
  loadMcpConfigs,
  type McpServerStatus,
  EventBus,
  RuntimePressureController,
  parseFileEditSuggestions,
  type FileEditSuggestion,
  initializeMcpServers,
  normalizeWorkerName,
  getRuntimeFlags,
} from "@agency/core";
import { emptyHistory, type History, type EditBuffer } from "./utils/text-buffer.js";
import { loadAgencyConfig, saveAgencyConfig, resolveApiKey, getModelThinkingConfig, getModelSpec, type ProviderId } from "@agency/providers";
import { Shell } from "./layout/Shell.js";
import { StatusBar } from "./layout/StatusBar.js";
import { Approval, type PendingApproval } from "./screens/Approval.js";
import { Splash } from "./components/Splash.js";
import { ComposerBlock } from "./components/ComposerBlock.js";
import { type SubagentStatus } from "./state/subagent-status.js";
import { WorkerProgress } from "./components/WorkerProgress.js";
import { globalWorkerTracker, SemanticTranslator, type WorkerState } from "./state/semantic-orchestration.js";


import { Conversation, calculateFormattedLines, getMaxScrollOffset } from "./components/Conversation.js";
import { HelpOverlay } from "./components/HelpOverlay.js";
import { ToolActivity } from "./components/ToolActivity.js";
import { ErrorBanner, type ErrorNotification } from "./components/ErrorBanner.js";
import { ConnectOverlay, getProviderInfo, type ProviderStatus } from "./components/ConnectOverlay.js";
import { ModelsOverlay } from "./components/ModelsOverlay.js";
import { VariantOverlay } from "./components/VariantOverlay.js";
import { RouteOverlay } from "./components/RouteOverlay.js";
import { SkillsPicker } from "./components/SkillsPicker.js";
import { ReviewMenu } from "./components/ReviewMenu.js";
import { StatusDashboard } from "./components/StatusDashboard.js";
import { PluginsOverlay } from "./components/PluginsOverlay.js";
import { extractPathCandidates, wrapText } from "./utils/text.js";
import { McpOverlay } from "./components/McpOverlay.js";
import { useKeyboardHandlers, type OverlayStates } from "./hooks/useKeyboardHandlers.js";



import { SubagentsOverlay } from "./components/SubagentsOverlay.js";
import { modeBudget, modeLabel, modeDescription, type AgentMode } from "./state/agent-modes.js";
import { getAtQuery } from "./at/utils.js";
import {
  filterSlashMenu,
  getSlashQuery,
} from "./presentation/slash-menu.js";
import { formatSystemNotice } from "./components/SystemNotice.js";
import { terminalBell } from "./motion/terminal.js";
import { loadTuiConfig } from "./config/tui-config.js";
import {
  createSession,
  loadLatestSession,
  loadSession,
  listSessionSummaries,
  deleteSession,
  type AgencySession,
  type SessionSummary,
} from "./sessions/store.js";
import { queueSaveSession, flushSessionSave } from "./sessions/persist-queue.js";
import { loadProjects, touchProject, isValidProject, type ProjectEntry } from "./sessions/projects.js";
import { SessionPicker } from "./components/SessionPicker.js";
import { WelcomeScreen } from "./components/WelcomeScreen.js";
import { WelcomeMenu } from "./components/WelcomeMenu.js";
import { GoalRunner, type GoalStep } from "./components/GoalRunner.js";
import { PlanPanel, type PlanTodo } from "./components/PlanPanel.js";
import { IndexProgressPanel } from "./components/IndexProgress.js";
import { executeSlash, parseSlashCommand } from "./slash/commands.js";
import { newMessageId, type SessionMessage } from "./state/messages.js";
import {
  type TranscriptFocus,
  inactiveFocus,
  focusedMessageId as resolveFocusedMessageId,
} from "./state/transcript-focus.js";
import {
  DEFAULT_THEME_ID,
  getTheme,
  type ThemeId,
} from "./themes/registry.js";
import {
  estimateContextUsage,
  getPhaseLabel,
  type ActivityPhase,
} from "./state/context-tracker.js";
import { useTerminalLayout } from "./layout/TerminalLayoutProvider.js";
import { setTuiPhase, getDegradationTier } from "./terminal/screen.js";
import { TerminalViewport } from "./layout/TerminalViewport.js";


export type { ScreenId } from "./types.js";



export interface AppProps {
  project?: string;
  skipSplash?: boolean;
  initialPendingApproval?: PendingApproval | null;
  onApprovalDecision?: (decision: "approve" | "deny", pending: PendingApproval) => void;
}

function pendingFromEnv(): PendingApproval | null {
  const raw = process.env.AGENCY_PENDING_TOOL?.trim();
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as PendingApproval;
    if (parsed && typeof parsed.toolName === "string") return parsed;
  } catch {
    return { toolName: raw };
  }
  return null;
}

function appendMessages(
  session: AgencySession,
  entries: (Omit<SessionMessage, "id" | "timestamp"> & { id?: string })[]
): AgencySession {
  const now = Date.now();
  return {
    ...session,
    messages: [
      ...session.messages,
      ...entries.map((e) => {
        const { id: presetId, ...rest } = e;
        return {
          ...rest,
          id: presetId ?? newMessageId(),
          timestamp: now,
        };
      }),
    ],
  };
}



export function estimateComposerHeight(buffer: string, contentCols: number, loading: boolean): number {
  const isPlaceholder = buffer.length === 0;
  if (isPlaceholder) {
    const hintsHeight = !loading ? 1 : 0;
    return 3 + hintsHeight;
  }
  const padding = 2;
  const prefix = 2;
  const availableWidth = Math.max(10, contentCols - padding - prefix);

  // 1. Calculate input content lines count
  const rawLines = buffer.split("\n");
  let totalContentLines = 0;
  for (let i = 0; i < rawLines.length; i++) {
    const rawLine = rawLines[i]!;
    if (i === 0) {
      const wrapped = wrapText(rawLine, Math.max(5, availableWidth));
      totalContentLines += Math.max(1, wrapped.length);
    } else {
      const wrapped = wrapText(rawLine, Math.max(5, availableWidth + prefix));
      totalContentLines += Math.max(1, wrapped.length);
    }
  }

  // Cap content lines at 6
  const visualContentLines = Math.min(6, totalContentLines);

  // 2. Estimate attachments row height (caps at 2 rows). Only reserve for tokens
  // that can actually surface a chip: explicit "@"-mentions or separator-bearing
  // paths. Dotted prose (`Array.map`, `react-dom.development.js`) resolves to
  // nothing and renders no chip, so reserving rows for it just wastes layout.
  const candidates = extractPathCandidates(buffer).filter(
    (c) => c.startsWith("@") || /[/\\]/.test(c),
  );
  let attachmentsHeight = 0;
  if (candidates.length > 0) {
    let totalBadgeWidth = 0;
    for (const c of candidates) {
      const filename = c.split(/[/\\]/).pop() || c;
      totalBadgeWidth += filename.length + 18;
    }
    const badgeRows = Math.ceil(totalBadgeWidth / (contentCols - 4));
    attachmentsHeight = Math.min(2, Math.max(1, badgeRows));
  }

  return visualContentLines + 2 + attachmentsHeight;
}

const MemoConversation = memo(Conversation);

function getThrottleInterval(): number {
  try {
    const { score } = RuntimePressureController.calculatePressure();
    if (score >= 0.8) return 500;
    if (score >= 0.6) return 250;
    if (score >= 0.3) return 100;
  } catch {
    // Ignore
  }
  return 60;
}

export function App({
  project: projectProp,
  skipSplash = false,
  initialPendingApproval = null,
  onApprovalDecision,
}: AppProps) {
  const project = resolvePath(projectProp ?? process.cwd());
  const { exit } = useApp();
  const layout = useTerminalLayout();
  const { cols, rows, contentWidth: contentCols, composerWidth } = layout;
  const config = useMemo(() => loadTuiConfig(project), [project]);
  const envPending = useMemo(() => pendingFromEnv(), []);

  const [phase, setPhase] = useState<"splash" | "welcome" | "main">(
    skipSplash ? "main" : "splash"
  );
  const [themeId, setThemeId] = useState<ThemeId>(
    (config.theme as ThemeId) ?? DEFAULT_THEME_ID
  );
  const theme = getTheme(themeId);

  useEffect(() => {
    setTuiPhase(phase);
  }, [phase]);

  // Resolve model name from config
  const [agencyConfig, setAgencyConfig] = useState(() => loadAgencyConfig());
  const configModelName = useMemo(() => {
    const provider = agencyConfig.defaultProvider;
    const profile = agencyConfig.providers[provider];
    const modelStr = profile?.model ?? provider;
    return `${provider}/${modelStr}`;
  }, [agencyConfig]);
  const [activeModelName, setActiveModelName] = useState<string | null>(null);
  const displayModelName = activeModelName ?? configModelName;

  const [session, setSession] = useState<AgencySession>(() =>
    loadLatestSession(project)
  );

  const [welcomeIndex, setWelcomeIndex] = useState(0);
  const [resumeIndex, setResumeIndex] = useState(0);
  const [projectIndex, setProjectIndex] = useState(0);
  const [sessionSummaries, setSessionSummaries] = useState<SessionSummary[]>([]);
  const [recentProjects, setRecentProjects] = useState<ProjectEntry[]>(() => loadProjects());
  const [pendingApproval, setPendingApproval] = useState<PendingApproval | null>(
    initialPendingApproval ?? envPending
  );
  const [overlays, setOverlays] = useState<OverlayStates>({
    connect: false,
    models: false,
    skills: false,
    review: false,
    status: false,
    plugins: false,
    variant: false,
    mcp: false,
    agents: false,
    resume: false,
    project: false,
    help: false,
    route: false,
  });

  const [expandedTui, setExpandedTui] = useState(false);
  const [mcpConnecting, setMcpConnecting] = useState(false);
  const [scrollOffset, setScrollOffset] = useState(0);
  const [activeSubagentId, setActiveSubagentId] = useState<string | null>(null);
  // Transcript focus/navigation state (flag `transcriptNav`). Off → stays inert.
  const [transcriptFocus, setTranscriptFocus] = useState<TranscriptFocus>(inactiveFocus);
  const userHasScrolledUpRef = useRef(false);

  const closeAllOverlays = useCallback(() => {
    setOverlays({
      connect: false,
      models: false,
      skills: false,
      review: false,
      status: false,
      plugins: false,
      variant: false,
      mcp: false,
      agents: false,
      resume: false,
      project: false,
      help: false,
      route: false,
    });
  }, []);

  const setOverlayOpen = useCallback((key: keyof OverlayStates, open: boolean) => {
    setOverlays((prev: OverlayStates) => ({ ...prev, [key]: open }));
  }, []);

  const toggleOverlay = useCallback((key: keyof OverlayStates) => {
    setOverlays((prev: OverlayStates) => ({ ...prev, [key]: !prev[key] }));
  }, []);

  const overlayActive =
    overlays.connect ||
    overlays.models ||
    overlays.skills ||
    overlays.review ||
    overlays.status ||
    overlays.plugins ||
    overlays.variant ||
    overlays.mcp ||
    overlays.agents ||
    overlays.resume ||
    overlays.project ||
    overlays.help ||
    overlays.route;

  const updateSession = useCallback(
    (updater: (s: AgencySession) => AgencySession, saveToDisk = true) => {
      setSession((prev) => {
        const next = updater(prev);
        if (saveToDisk) {
          queueSaveSession(next);
        }
        return next;
      });
    },
    []
  );

  const patchMessage = useCallback(
    (
      messageId: string,
      patch: Partial<SessionMessage> | ((msg: SessionMessage) => Partial<SessionMessage>),
      saveToDisk = true
    ) => {
      updateSession((s) => ({
        ...s,
        messages: s.messages.map((m) => {
          if (m.id !== messageId) return m;
          const nextPatch =
            typeof patch === "function" ? patch(m) : patch;
          return { ...m, ...nextPatch };
        }),
      }), saveToDisk);
    },
    [updateSession]
  );

  const addSystemLines = useCallback(
    (lines: string[]) => {
      updateSession((s) =>
        appendMessages(
          s,
          lines.map((content) => ({
            role: "system" as const,
            content: formatSystemNotice(content),
          }))
        )
      );
    },
    [updateSession]
  );

  const addShellExecution = useCallback(
    (cmd: string, output: string) => {
      updateSession((s) =>
        appendMessages(s, [
          {
            role: "system" as const,
            content: `SHELL_EXECUTION: $ ${cmd}\n${output}`,
          },
        ])
      );
    },
    [updateSession]
  );
  const [buffer, setBuffer] = useState("");
  // Cursor-editing state (flag `composerCursorEdit`). When off, cursorPos is
  // unused and the composer stays append-only / end-pinned (byte-identical).
  const composerCursorEdit = useMemo(() => getRuntimeFlags().composerCursorEdit, []);
  // Transcript navigation flag (Ctrl+T focus + ↑/↓ between turns). Off → keys keep
  // their legacy meaning and the render is byte-identical.
  const transcriptNav = useMemo(() => getRuntimeFlags().transcriptNav, []);
  const [cursorPos, setCursorPos] = useState(0);
  // Authoritative editing state, read+written synchronously by the keystroke
  // handler so rapid typing/paste bursts never read a batched-stale caret. The
  // `cursorPos` React state is just a render mirror.
  const editBufRef = useRef<EditBuffer>({ text: "", cursor: 0 });
  const editHistoryRef = useRef<History>(emptyHistory());
  // Set by the caret-aware edit path right before it updates the buffer, so the
  // effect below can tell an internal edit (keep caret + undo history) from an
  // external buffer change (slash inject, @ completion, alias, clear → caret to
  // end + fresh history).
  const internalEditRef = useRef(false);
  useEffect(() => {
    if (!composerCursorEdit) return;
    if (internalEditRef.current) {
      internalEditRef.current = false;
      return;
    }
    // External buffer change: re-sync the editing ref and park the caret at the
    // end with a fresh undo history.
    editBufRef.current = { text: buffer, cursor: buffer.length };
    setCursorPos(buffer.length);
    editHistoryRef.current = emptyHistory();
  }, [buffer, composerCursorEdit]);
  const [loading, setLoading] = useState(false);
  const [subagents, setSubagents] = useState<SubagentStatus[]>([]);

  // Error notification state
  const [errorNotifications, setErrorNotifications] = useState<ErrorNotification[]>([]);
  const pushError = useCallback((message: string) => {
    const id = `err-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    setErrorNotifications((prev) => [...prev.slice(-4), { id, message, timestamp: Date.now() }]);
  }, []);
  const dismissError = useCallback((id: string) => {
    setErrorNotifications((prev) => prev.map((e) => e.id === id ? { ...e, dismissed: true } : e));
  }, []);

  // Queue state refs
  const promptQueueRef = useRef<string[]>([]);
  const processingRef = useRef(false);

  // Goal runner state
  const [goalActive, setGoalActive] = useState(false);
  const [goalTask, setGoalTask] = useState("");
  const [goalSteps, setGoalSteps] = useState<GoalStep[]>([]);
  // Live plan/todo list for the normal Agent chat, driven by the `plan:updated`
  // event the `update_plan` tool publishes (distinct from /goal's GoalRunner).
  const [planTodos, setPlanTodos] = useState<PlanTodo[]>([]);
  const [goalCurrentStep, setGoalCurrentStep] = useState(0);
  const [goalStartMs, setGoalStartMs] = useState(0);
  const [goalRunnerViewMode, setGoalRunnerViewMode] = useState<"flat" | "boxy">(
    config.goalRunnerViewMode ?? "flat"
  );

  const degradationTier = getDegradationTier(session.messages.length);
  const survivalModeActive = degradationTier === 3;

  const messagesToProcess = useMemo(() => {
    if (survivalModeActive) {
      return session.messages.slice(-15);
    }
    return session.messages;
  }, [session.messages, survivalModeActive]);

  const latestAssistantId = useMemo(() => {
    const msgs = messagesToProcess;
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i]?.role === "assistant" && !msgs[i]?.streaming) {
        return msgs[i]!.id;
      }
    }
    return null;
  }, [messagesToProcess]);

  const virtualLinesCount = useMemo(() => {
    const msgs = messagesToProcess;
    return calculateFormattedLines(msgs, composerWidth, theme, latestAssistantId, subagents, loading, expandedTui, undefined, goalActive).length;
  }, [messagesToProcess, composerWidth, theme, latestAssistantId, subagents, loading, expandedTui, goalActive]);

  // The message currently holding the transcript-nav focus highlight (flag-gated).
  const focusedMessageId = useMemo(
    () => (transcriptNav && transcriptFocus.active ? resolveFocusedMessageId(transcriptFocus, messagesToProcess) : null),
    [transcriptNav, transcriptFocus, messagesToProcess]
  );

  const [lastRouteProvider, setLastRouteProvider] = useState<string | null>(
    null
  );
  const abortRef = useRef<AbortController | null>(null);
  const hasPendingApprovalRef = useRef(false);
  const autoApproveRef = useRef(false);
  const pendingFileEditsRef = useRef<FileEditSuggestion[]>([]);
  const showNextFileEditApprovalRef = useRef<() => void>(() => { });

  // Indexing state
  const [indexing, setIndexing] = useState(false);
  // Whether a fresh workspace index actually exists. Distinct from `!indexing`
  // (which only means "not building right now") so the welcome screen doesn't
  // claim "Ready ✓" before the index is confirmed, or after a silent build
  // failure. Set true only when the index is fresh or a build succeeds.
  const [indexReady, setIndexReady] = useState(false);
  const [indexProgress, setIndexProgress] = useState<import("@agency/core").IndexProgress | null>(null);
  const indexAbortControllerRef = useRef<AbortController | null>(null);

  const handleCancelOrAbort = useCallback(() => {
    let handled = false;
    if (goalActive) {
      abortRef.current?.abort();
      abortRef.current = null;
      promptQueueRef.current = [];
      processingRef.current = false;
      hasPendingApprovalRef.current = false;
      pendingFileEditsRef.current = [];
      setGoalActive(false);
      setLoading(false);
      setActivityPhase("idle");
      addSystemLines(["✗ Goal execution aborted by user"]);
      handled = true;
    }
    if (indexing) {
      if (indexAbortControllerRef.current) {
        indexAbortControllerRef.current.abort();
        indexAbortControllerRef.current = null;
      }
      setIndexing(false);
      setIndexProgress(null);
      addSystemLines(["✗ Indexing aborted by user"]);
      handled = true;
    }
    if (loading && !handled) {
      abortRef.current?.abort();
      abortRef.current = null;
      promptQueueRef.current = [];
      processingRef.current = false;
      hasPendingApprovalRef.current = false;
      pendingFileEditsRef.current = [];
      setPendingApproval(null);
      setLoading(false);
      setActivityPhase("idle");
      addSystemLines(["⨉ Cancelled"]);
      handled = true;
    }
    return handled;
  }, [goalActive, indexing, loading, addSystemLines]);

  const safeExit = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    indexAbortControllerRef.current?.abort();
    indexAbortControllerRef.current = null;
    flushSessionSave();
    exit();
  }, [exit]);

  // Phase 2: model, context, activity tracking
  const [activityPhase, setActivityPhase] = useState<ActivityPhase>("idle");
  const [tokenCount, setTokenCount] = useState(0);
  const [loadStartMs, setLoadStartMs] = useState(0);

  const [agentMode, setAgentMode] = useState<AgentMode>("agent");
  const [lastUsage, setLastUsage] = useState<any>(null);
  const [mcpServers, setMcpServers] = useState<McpServerStatus[]>([]);
  const [sessionDeletingId, setSessionDeletingId] = useState<string | null>(null);

  useEffect(() => {
    if (overlays?.status || overlays?.mcp || overlays?.variant || overlays?.connect || overlays?.models) {
      setAgencyConfig(loadAgencyConfig());
    }
    if (overlays?.status || overlays?.mcp) {
      setMcpServers(loadMcpConfigs(project));
    }
  }, [overlays?.status, overlays?.mcp, overlays?.variant, overlays?.connect, overlays?.models, project]);
  const [availableModels, setAvailableModels] = useState<import("@agency/providers").ModelInfo[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);

  // Phase 4: resume & project picker

  // Set terminal background color dynamically using OSC 11 ANSI escape sequence
  useEffect(() => {
    process.stdout.write(`\x1b]11;${theme.bg}\x07`);
    return () => {
      // Reset terminal background color on exit/unmount
      process.stdout.write("\x1b]111\x07");
    };
  }, [theme.bg]);

  // Auto-register project on startup
  useEffect(() => {
    if (isValidProject(project)) {
      touchProject(project);
    }
  }, [project]);

  // Dynamic MCP Servers initialization on startup/project change
  useEffect(() => {
    if (isValidProject(project)) {
      setMcpConnecting(true);
      initializeMcpServers(project).finally(() => {
        setMcpConnecting(false);
      });
    }
  }, [project]);

  // Subagents live tracking state
  useEffect(() => {
    let subagentsUpdateTimeout: NodeJS.Timeout | null = null;
    let lastSubagentsUpdateMs = 0;
    let pendingTrackerList: any[] | null = null;

    const flushSubagents = (trackerList: any[]) => {
      setSubagents(trackerList.map(w => {
        const activeStep = w.steps?.find((s: any) => s.status === "active");
        const progressDetail = activeStep ? activeStep.label : SemanticTranslator.translatePhase(w.state, w.targetFile);
        const isRunning = w.state !== "COMPLETED" && w.state !== "FAILED";
        // A worker's self-reported elapsedMs freezes during long LLM turns (no
        // progress events). Derive live wall-clock elapsed from the spawn
        // timestamp while running; freeze at the final value once finished.
        const spawnTs = w.timeline?.[0]?.timestamp;
        const elapsedMs = isRunning && typeof spawnTs === "number"
          ? Date.now() - spawnTs
          : w.elapsedMs;
        return {
          agentId: w.agentId,
          task: w.task,
          status: w.state === "COMPLETED" ? "done" as const : w.state === "FAILED" ? "error" as const : "running" as const,
          phase: progressDetail,
          elapsedMs,
          // Stable anchor so the elapsed readouts self-tick in their leaf
          // components instead of needing a per-second whole-App re-flush.
          spawnTs: typeof spawnTs === "number" ? spawnTs : undefined,
          steps: w.steps,
        };
      }));
      lastSubagentsUpdateMs = Date.now();
      subagentsUpdateTimeout = null;
    };

    // 1. Subscribe local state to globalWorkerTracker updates
    const unsubscribeTracker = globalWorkerTracker.subscribe((trackerList) => {
      const now = Date.now();
      // Elapsed counters now self-tick in their leaf components (anchored to
      // spawnTs), so this flush only needs to keep phase/step/status fresh.
      // Floor the cadence at 250ms (4Hz) to cut full-App re-renders under
      // streaming load — the visible second counters stay smooth regardless.
      const throttleInterval = Math.max(getThrottleInterval(), 250);
      pendingTrackerList = trackerList;

      if (now - lastSubagentsUpdateMs >= throttleInterval) {
        if (subagentsUpdateTimeout) {
          clearTimeout(subagentsUpdateTimeout);
          subagentsUpdateTimeout = null;
        }
        flushSubagents(trackerList);
      } else if (!subagentsUpdateTimeout) {
        subagentsUpdateTimeout = setTimeout(() => {
          if (pendingTrackerList) {
            flushSubagents(pendingTrackerList);
          }
        }, throttleInterval - (now - lastSubagentsUpdateMs));
      }
    });

    // 2. Setup EventBus listeners that drive the tracker
    const handleSubagentStarted = (event: any) => {
      const payload = typeof event.payload === "string" ? JSON.parse(event.payload) : event.payload;
      globalWorkerTracker.registerWorker(payload.agentId, payload.task);
    };

    const handleSubagentProgress = (event: any) => {
      const payload = typeof event.payload === "string" ? JSON.parse(event.payload) : event.payload;

      let nextState: WorkerState = "ANALYZING";
      let targetFile = "";
      if (payload.phase) {
        const lowerPhase = payload.phase.toLowerCase();
        if (lowerPhase.includes("routing") || lowerPhase.includes("routing prompt")) {
          nextState = "ACQUIRING_CONTEXT";
        } else if (lowerPhase.includes("executing llm") || lowerPhase.includes("streaming") || lowerPhase.includes("thinking")) {
          nextState = "ANALYZING";
        } else if (lowerPhase.includes("staging")) {
          nextState = "SYNTHESIZING";
          const match = payload.phase.match(/Staging:\s*(.+)$/i);
          if (match) targetFile = match[1];
        } else if (lowerPhase.includes("committing")) {
          nextState = "CONSOLIDATING";
        } else if (lowerPhase.includes("verifying") || lowerPhase.includes("validating")) {
          nextState = "VERIFYING";
          const match = payload.phase.match(/(?:validating|verifying)\s*(.+)$/i);
          if (match) targetFile = match[1];
        } else if (lowerPhase.includes("self-healing")) {
          nextState = "SELF_HEALING";
        }
      }

      let label = payload.phase || "";
      if (payload.step) {
        const rawLabel = payload.step.label || "";
        const toolMatch = rawLabel.match(/^([a-zA-Z0-9_-]+):?\s*(.*)$/);
        if (toolMatch) {
          const toolName = toolMatch[1]!;
          const args = toolMatch[2] || "";
          label = SemanticTranslator.translateTool(toolName, args);
        } else {
          label = rawLabel;
        }
      }

      let stepPayload: { label: string; status: "done" | "active" | "pending" } | undefined = undefined;
      if (payload.step) {
        stepPayload = {
          label,
          status: payload.step.status,
        };
      }

      globalWorkerTracker.transitionWorker(payload.agentId, nextState, label, targetFile, stepPayload);
      if (payload.elapsedMs) {
        globalWorkerTracker.updateProgress(payload.agentId, payload.elapsedMs);
      }
    };

    const handleSubagentFinished = (event: any) => {
      const payload = typeof event.payload === "string" ? JSON.parse(event.payload) : event.payload;
      globalWorkerTracker.transitionWorker(payload.agentId, "COMPLETED", payload.result || "Finished successfully");
      if (payload.elapsedMs) {
        globalWorkerTracker.updateProgress(payload.agentId, payload.elapsedMs);
      }
    };

    const handleSubagentError = (event: any) => {
      const payload = typeof event.payload === "string" ? JSON.parse(event.payload) : event.payload;
      globalWorkerTracker.transitionWorker(payload.agentId, "FAILED", payload.result || "Subagent execution failed");
      if (payload.elapsedMs) {
        globalWorkerTracker.updateProgress(payload.agentId, payload.elapsedMs);
      }
    };

    // Live plan/todo list — the model calls `update_plan` with the full current
    // list each time; we mirror it verbatim (per-item status is the model's, not
    // a decorative flip). Survives until the next update or session switch.
    const handlePlanUpdated = (event: any) => {
      const payload = typeof event.payload === "string" ? JSON.parse(event.payload) : event.payload;
      if (Array.isArray(payload?.todos)) {
        setPlanTodos(
          payload.todos
            .filter((t: any) => t && typeof t.step === "string" && t.step.trim())
            .map((t: any) => ({ step: String(t.step), status: String(t.status ?? "pending") }))
        );
      }
    };

    EventBus.getInstance().subscribe("subagent:started", handleSubagentStarted);
    EventBus.getInstance().subscribe("subagent:progress", handleSubagentProgress);
    EventBus.getInstance().subscribe("subagent:finished", handleSubagentFinished);
    EventBus.getInstance().subscribe("subagent:error", handleSubagentError);
    EventBus.getInstance().subscribe("plan:updated", handlePlanUpdated);

    // No per-second "live elapsed" heartbeat: the elapsed readouts self-tick in
    // their leaf components (anchored to each worker's spawnTs), so we no longer
    // re-flush the whole subagents array — and re-render the App — once a second
    // just to advance a counter. Phase/step/status still flush on real progress
    // events. This removes a steady stream of full-App reconciles + ConPTY frame
    // writes during subagent execution, which is what made the counters feel
    // laggy even after the hard freeze was fixed.

    return () => {
      unsubscribeTracker();
      if (subagentsUpdateTimeout) {
        clearTimeout(subagentsUpdateTimeout);
      }
      EventBus.getInstance().unsubscribe("subagent:started", handleSubagentStarted);
      EventBus.getInstance().unsubscribe("subagent:progress", handleSubagentProgress);
      EventBus.getInstance().unsubscribe("subagent:finished", handleSubagentFinished);
      EventBus.getInstance().unsubscribe("subagent:error", handleSubagentError);
      EventBus.getInstance().unsubscribe("plan:updated", handlePlanUpdated);
    };
  }, []);






  // Resolve model name from config (moved higher in component body)


  // Compute thinking label for header/composer badge
  const thinkingLabel = useMemo(() => {
    const provider = agencyConfig.defaultProvider;
    const profile = agencyConfig.providers[provider];
    const modelStr = profile?.model ?? provider;

    let thinkingConfig;
    try {
      thinkingConfig = getModelThinkingConfig(provider, modelStr);
    } catch {
      return undefined;
    }

    if (!thinkingConfig || !thinkingConfig.supported) {
      return undefined; // Model does not support thinking
    }

    // Resolve the active thinking value: use profile setting, or fallback to the config's default
    const thinking = profile?.thinking !== undefined && profile?.thinking !== null
      ? profile.thinking
      : thinkingConfig.default;

    if (thinking === 0 || thinking === "off") return "off";
    if (typeof thinking === "string") return thinking; // effort-based: "low"/"medium"/"high"
    if (typeof thinking === "number") {
      // Try to match a named variant
      const match = thinkingConfig.variants?.find((v: any) => v.value === thinking);
      if (match) return match.name;
      // Format as approximate token count
      if (thinking >= 1000) return `~${(thinking / 1000).toFixed(0)}K`;
      return String(thinking);
    }
    return undefined;
  }, [agencyConfig]);

  // Resolve active thinking variant config for overlay
  const variantConfig = useMemo(() => {
    const providerId = agencyConfig.defaultProvider;
    const profile = agencyConfig.providers[providerId];
    const modelName = profile?.model ?? providerId;
    const spec = getModelSpec(modelName);
    const thinkingConfig = getModelThinkingConfig(providerId, modelName);
    return {
      providerId,
      modelName,
      modelSpec: spec,
      variants: thinkingConfig.variants,
      currentThinking: profile?.thinking,
    };
  }, [agencyConfig]);

  // Check routing weights existence
  const hasRoutingWeights = useMemo(() => {
    try {
      return existsSync(join(project, ".agency", "routing-weights.json"));
    } catch {
      return false;
    }
  }, [project]);

  // Provider status for overlays
  const providerStatuses: ProviderStatus[] = useMemo(() => {
    const ids: ProviderId[] = ["nvidia", "openrouter", "google", "openai", "anthropic", "local"];
    return ids.map((id) => {
      const info = getProviderInfo(id);
      const profile = agencyConfig.providers[id];
      const hasKey = id === "local"
        ? Boolean(profile && Object.keys(profile).length > 0)
        : Boolean(resolveApiKey(profile)?.trim());
      return { id, label: info.label, icon: info.icon, configured: hasKey };
    });
  }, [agencyConfig]);

  // Context window tracking
  const contextUsage = useMemo(
    () => estimateContextUsage(session.messages, displayModelName),
    [session.messages, displayModelName]
  );

  const atActive = useMemo(() => getAtQuery(buffer), [buffer]);
  const slashActive = useMemo(() => getSlashQuery(buffer), [buffer]);
  const slashSuggestions = useMemo(() => {
    if (!slashActive) return [];
    return filterSlashMenu(slashActive.query);
  }, [slashActive]);
  const atSuggestions = useMemo(() => {
    if (!atActive) return [];
    return fuzzySearchFiles(project, atActive.query, 30);
  }, [atActive, project]);

  // Register provider warning bridge & handle warning events
  useEffect(() => {
    (globalThis as any).onAgencyProviderWarning = (msg: string) => {
      void EventBus.getInstance().publish("system:warning", { message: msg });
    };

    (globalThis as any).onAgencyEventBusError = (msg: string) => {
      // Route through addSystemLines directly to avoid recursive EventBus publish
      addSystemLines([`⚠ ${msg}`]);
    };

    // Non-fatal runtime errors (uncaught exceptions / unhandled rejections) are
    // routed here by terminal/screen.ts instead of killing the process. Surface
    // them as a dim system line and keep the session alive — never eject to the
    // shell. Routed directly (not via EventBus) to avoid recursive publishes.
    (globalThis as any).onAgencyRuntimeError = (msg: string) => {
      addSystemLines([`⚠ ${msg}`]);
    };

    const handleSystemWarning = (event: any) => {
      const payload = typeof event.payload === "string" ? JSON.parse(event.payload) : event.payload;
      const msgText = payload.message || "";

      const isRetryWarning =
        msgText.includes("Rate Limit / Transient Error") ||
        msgText.includes("Stream Failsafe Recovery") ||
        msgText.includes("LLM request failed. Attempt");

      if (isRetryWarning) {
        updateSession((s) => {
          let targetIdx = -1;
          for (let idx = s.messages.length - 1; idx >= 0; idx--) {
            const m = s.messages[idx]!;
            if (m.role === "system" && (m.content.includes("Rate Limit / Transient Error") || m.content.includes("Stream Failsafe Recovery") || m.content.includes("LLM request failed. Attempt"))) {
              targetIdx = idx;
              break;
            }
          }

          if (targetIdx !== -1) {
            return {
              ...s,
              messages: s.messages.map((m, idx) =>
                idx === targetIdx
                  ? { ...m, content: formatSystemNotice(`⚠ ${msgText}`) }
                  : m
              )
            };
          } else {
            return appendMessages(s, [{ role: "system", content: formatSystemNotice(`⚠ ${msgText}`) }]);
          }
        });
      } else {
        const hasCustomIcon =
          msgText.startsWith("[MCP]") ||
          msgText.startsWith("✓") ||
          msgText.startsWith("⌛") ||
          msgText.startsWith("⚙") ||
          msgText.startsWith("⚠");
        const prefix = hasCustomIcon ? "" : "⚠ ";
        const line = formatSystemNotice(`${prefix}${msgText}`);
        // Collapse an immediately-repeated identical warning into one "× N" line
        // instead of stacking duplicate blocks (e.g. a circuit breaker that trips
        // across several consecutive retries). Honest — the count shows it recurred.
        updateSession((s) => {
          const lastIdx = s.messages.length - 1;
          const last = s.messages[lastIdx];
          if (last && last.role === "system") {
            const prevBase = last.content.replace(/ ×\d+$/, "");
            if (prevBase === line) {
              const m = last.content.match(/ ×(\d+)$/);
              const count = m ? parseInt(m[1]!, 10) + 1 : 2;
              return {
                ...s,
                messages: s.messages.map((msg, i) =>
                  i === lastIdx ? { ...msg, content: `${line} ×${count}` } : msg
                ),
              };
            }
          }
          return appendMessages(s, [{ role: "system" as const, content: line }]);
        });
      }
    };

    const handleSecurityAlert = (event: any) => {
      const payload = typeof event.payload === "string" ? JSON.parse(event.payload) : event.payload;
      const countMsg = payload.count > 1 ? ` (${payload.count} times)` : "";
      addSystemLines([
        `🛡️  SECURITY WARNING: Sandbox blocked unauthorized outbound network attempt to: ${payload.domain}${countMsg}.`
      ]);
    };

    // verify-main-turn: the self-heal loop ran out of rounds and the edit still
    // doesn't pass acceptance. The intermediate "self-healing (round N)…" lines
    // come from the per-turn `chat:self-healing` handler; this terminal event
    // tells the user the result didn't ultimately verify (rather than silently
    // returning the last broken attempt). Main-turn only — `verifyAndHeal` is the
    // sole emitter; no-op unless verifyMainTurn is on.
    const handleVerifyFailed = (event: any) => {
      const payload = typeof event.payload === "string" ? JSON.parse(event.payload) : event.payload;
      const rounds = payload?.rounds ?? "the allotted";
      addSystemLines([
        `⚠ Verification still failing after ${rounds} self-heal round(s) — the changes may not build/lint cleanly. Review the errors above; ask me to continue for another attempt.`
      ]);
    };

    EventBus.getInstance().subscribe("system:warning", handleSystemWarning);
    EventBus.getInstance().subscribe("security:egress-denied", handleSecurityAlert);
    EventBus.getInstance().subscribe("chat:verify-failed", handleVerifyFailed);

    return () => {
      delete (globalThis as any).onAgencyProviderWarning;
      delete (globalThis as any).onAgencyEventBusError;
      delete (globalThis as any).onAgencyRuntimeError;
      EventBus.getInstance().unsubscribe("system:warning", handleSystemWarning);
      EventBus.getInstance().unsubscribe("security:egress-denied", handleSecurityAlert);
      EventBus.getInstance().unsubscribe("chat:verify-failed", handleVerifyFailed);
    };
  }, [addSystemLines, updateSession]);

  // Auto background probe for unknown models
  useEffect(() => {
    if (!displayModelName) return;
    const parts = displayModelName.split("/");
    const providerId = parts[0] as ProviderId;
    const model = parts.slice(1).join("/");
    if (!providerId || !model) return;

    let active = true;

    // Check if we need to probe this model
    import("@agency/providers").then(async ({ getModelSpec, probeModel, resolveApiKey, updateModelOverride }) => {
      if (!active) return;
      const spec = getModelSpec(model);
      const needsProbe = spec.specSource === "heuristics" || spec.specSource === "default";
      if (!needsProbe) return;

      // Check if key exists
      const profile = agencyConfig.providers[providerId] ?? {};
      const key = resolveApiKey(profile);
      if (!key && providerId !== "local") return;

      addSystemLines([`⚙ Auto-optimizing specifications for model: ${model}...`]);
      try {
        const res = await probeModel(providerId, model, agencyConfig);
        if (!active) return;
        if (res.success) {
          const changed =
            res.contextWindow !== res.baselineContextWindow ||
            res.maxOutputTokens !== res.baselineMaxOutput ||
            res.thinkingType !== res.baselineThinking;

          if (changed) {
            updateModelOverride(model, {
              contextWindow: res.contextWindow,
              maxOutputTokens: res.maxOutputTokens,
              thinkingType: res.thinkingType,
            });

            const { loadAgencyConfig } = await import("@agency/providers");
            if (!active) return;
            setAgencyConfig(loadAgencyConfig());
            addSystemLines([
              `✓ Optimized and saved specifications for ${model}:`,
              `  • Context: ${res.contextWindow.toLocaleString("en-US")} tokens`,
              `  • Max Output: ${res.maxOutputTokens.toLocaleString("en-US")} tokens`,
              `  • Thinking: ${res.thinkingType}`
            ]);
          } else {
            addSystemLines([
              `✓ Diagnostic specifications for ${model} match the baseline. Preserved defaults.`
            ]);
          }
        }
      } catch (err: any) {
        console.error("Auto background probe failed:", err);
      }
    });

    return () => {
      active = false;
    };
  }, [displayModelName, agencyConfig, addSystemLines]);



  const runSlash = useCallback(
    async (slashInput: string) => {
      const slash = await executeSlash(slashInput, {
        projectRoot: project,
        themeId,
        session,
      });
      if (slash.exit) {
        safeExit();
        return;
      }
      if (slash.themeId) setThemeId(slash.themeId);
      if (slash.reloadConfig) {
        setAgencyConfig(loadAgencyConfig());
      }
      if (slash.newSession) {
        const fresh = createSession(project);
        updateSession(() => fresh);
      }
      if (slash.clearRouteCache) {
        const { clearRouteCache } = await import("@agency/core");
        clearRouteCache(project);
      }
      if (slash.showHelp) {
        closeAllOverlays();
        setOverlayOpen("help", true);
        addSystemLines(["? Opening Help & Shortcuts overlay..."]);
      }
      if (slash.showRouteOverlay) {
        closeAllOverlays();
        setOverlayOpen("route", true);
        addSystemLines(["🎯 Opening Route Feedback Selector overlay..."]);
      }
      if (slash.compactSession || slash.compactDryRun) {
        const msgs = session.messages;
        const keep = 6; // keep last N messages
        if (msgs.length <= keep) {
          addSystemLines([`Context is already compact (${msgs.length} messages).`]);
        } else {
          const oldMsgs = msgs.slice(0, msgs.length - keep);
          const summary = oldMsgs
            .filter((m) => m.role !== "system")
            .map((m) => `[${m.role}] ${m.content.slice(0, 80)}`)
            .join(" | ");
          const compactSummary = summary.length > 300
            ? `${summary.slice(0, 297)}…`
            : summary;
          if (slash.compactDryRun) {
            addSystemLines([
              `Would compact ${oldMsgs.length} messages → 1 summary.`,
              `Preview: ${compactSummary}`,
              `Run /compact to execute.`,
            ]);
          } else {
            const kept = msgs.slice(msgs.length - keep);
            updateSession((s) => ({
              ...s,
              messages: [
                {
                  id: newMessageId(),
                  role: "system" as const,
                  content: `[compacted ${oldMsgs.length} messages] ${compactSummary}`,
                  timestamp: Date.now(),
                },
                ...kept,
              ],
            }));
            addSystemLines([
              `✓ Compacted ${oldMsgs.length} messages → 1 summary + ${kept.length} recent.`,
            ]);
          }
        }
      }
      // Phase 3: overlay commands
      if (slash.showConnect) {
        closeAllOverlays();
        setOverlayOpen("connect", true);
        addSystemLines(["◆ Opening API Connections Manager overlay..."]);
      }
      if (slash.showModels) {
        closeAllOverlays();
        setOverlayOpen("models", true);
        setModelsLoading(true);
        addSystemLines(["▣ Opening Model Selector overlay..."]);
        import("@agency/providers").then(({ listAllModels }) => {
          listAllModels().then((models) => {
            setAvailableModels(models);
            setModelsLoading(false);
          }).catch(() => setModelsLoading(false));
        }).catch(() => setModelsLoading(false));
      }
      if (slash.showSkills) {
        closeAllOverlays();
        setOverlayOpen("skills", true);
        addSystemLines(["◇ Opening Skills Picker overlay..."]);
      }
      if (slash.showPlugins) {
        closeAllOverlays();
        setOverlayOpen("plugins", true);
        addSystemLines(["p Opening Plugins Manager overlay..."]);
      }
      if (slash.showReview) {
        closeAllOverlays();
        setOverlayOpen("review", true);
        addSystemLines(["△ Opening Code Review menu..."]);
      }
      if (slash.showStatus) {
        closeAllOverlays();
        setOverlayOpen("status", true);
        addSystemLines(["⚙ Opening System Status Dashboard overlay..."]);
      }
      if (slash.showMcp) {
        closeAllOverlays();
        setOverlayOpen("mcp", true);
        addSystemLines(["⊡ Opening MCP Console overlay..."]);
      }
      if (slash.showVariant) {
        closeAllOverlays();
        setOverlayOpen("variant", true);
        addSystemLines(["v Opening Thinking Budget Selector..."]);
      }
      if (slash.injectPrompt) {
        setBuffer(slash.injectPrompt);
      }
      if (slash.showResume) {
        closeAllOverlays();
        setSessionSummaries(listSessionSummaries(project));
        setResumeIndex(0);
        setOverlayOpen("resume", true);
        addSystemLines(["↺ Opening Sessions Manager..."]);
      }
      if (slash.showProject) {
        closeAllOverlays();
        setRecentProjects(loadProjects());
        setProjectIndex(0);
        setOverlayOpen("project", true);
        addSystemLines(["◈ Opening Project Switcher overlay..."]);
      }
      if (slash.goalTask) {
        const taskDesc = slash.goalTask;
        setGoalTask(taskDesc);
        setGoalActive(true);
        setGoalStartMs(Date.now());
        setLoading(true);
        addSystemLines([`⊕ Goal started: ${taskDesc}`]);

        // Helper to parse hierarchical phases and checkbox items
        const parseHierarchicalPlan = (text: string): GoalStep[] => {
          const stepsList: GoalStep[] = [];
          const lines = text.split("\n");
          let currentStep: GoalStep | null = null;
          let todoCounter = 1;

          lines.forEach((lineText) => {
            const trimmed = lineText.trim();
            const phaseMatch =
              trimmed.match(/^###\s+(?:Task|Phase)\s+(\d+)\s*:\s*(?:Phase\s+)?(.+)$/i) ||
              trimmed.match(/^###\s+(\d+)\s*:\s*(?:Phase\s+)?(.+)$/i) ||
              trimmed.match(/^###\s+(?:Task|Phase)\s+(\d+)\s+(.+)$/i);

            if (phaseMatch) {
              const id = parseInt(phaseMatch[1]!, 10);
              const title = phaseMatch[2]!.trim().replace(/^[:-]\s*/, "");
              currentStep = {
                id,
                title,
                status: "pending",
                todos: [],
              };
              stepsList.push(currentStep);
              todoCounter = 1;
            } else if (
              currentStep &&
              (trimmed.startsWith("- [ ]") ||
                trimmed.startsWith("- [  ]") ||
                trimmed.startsWith("- [x]") ||
                trimmed.startsWith("- [/]") ||
                trimmed.startsWith("* [ ]") ||
                trimmed.startsWith("* [x]"))
            ) {
              const checked = trimmed.startsWith("- [x]") || trimmed.startsWith("* [x]");
              const running = trimmed.startsWith("- [/]") || trimmed.startsWith("* [/]");
              const todoText = trimmed.replace(/^[-*]\s*\[[\s/xX]?\]\s*/, "").trim();
              if (todoText) {
                currentStep.todos = currentStep.todos || [];
                currentStep.todos.push({
                  id: `${currentStep.id}.${todoCounter++}`,
                  title: todoText,
                  status: checked ? "done" : running ? "running" : "pending",
                });
              }
            } else if (currentStep && trimmed.startsWith("- ")) {
              const todoText = trimmed.slice(2).trim();
              if (todoText && !todoText.startsWith("[") && !todoText.startsWith("Phase")) {
                currentStep.todos = currentStep.todos || [];
                currentStep.todos.push({
                  id: `${currentStep.id}.${todoCounter++}`,
                  title: todoText,
                  status: "pending",
                });
              }
            }
          });

          return stepsList;
        };

        // Generate plan via LLM, then run it
        (async () => {
          try {
            const { runChatTurnWithStream: streamFn, parsePlanTasks, runPlan } = await import("@agency/core");
            const skillsRoot = process.env.AGENCY_SKILLS_ROOT?.trim() || resolveSkillsRoot();

            // Step 1: Generate plan with explicit Phase & checklist instructions
            const planPrompt = `Break this goal into a structured multi-phase software engineering plan.
Each phase must begin with a heading formatted exactly as:
### Task N: Phase [Phase Title]
And under each phase, list the specific detailed todo items as a markdown checklist (using "- [ ]"). For example:
### Task 1: Phase Exploration & Planning
- [ ] Research the codebase and modules
- [ ] Formulate target refactoring plan

Goal to plan:
${taskDesc}`;

            let planText = "";
            await streamFn(
              { prompt: planPrompt, projectRoot: project, skillsRoot, budget: "deep" },
              {
                onRoute: () => { },
                onDelta: (d) => { planText += d; },
              }
            );

            // Parse steps using our custom hierarchical parser
            let stepsList = parseHierarchicalPlan(planText);

            // Fallback to core flat task parser if custom parser yielded nothing
            if (stepsList.length === 0) {
              const tasks = parsePlanTasks(planText);
              stepsList = tasks.map((t) => ({ id: t.id, title: t.title, status: "pending", todos: [] }));
            }

            if (stepsList.length === 0) {
              addSystemLines(["Could not parse plan tasks. Treating as single task."]);
              setGoalSteps([{ id: 1, title: taskDesc, status: "done", todos: [] }]);
              setGoalActive(false);
              setLoading(false);
              return;
            }

            // Initialize steps display with the parsed todos
            setGoalSteps(stepsList);

            // Step 2: Run plan with progress tracking
            const writeFileSync = (await import("node:fs")).writeFileSync;
            const tmpPlan = join(project, ".agency", "goal-plan.md");
            writeFileSync(tmpPlan, planText, "utf8");

            await runPlan(project, tmpPlan, {
              skillsRoot,
              harness: true,
              maxAttempts: 3,
              onTaskStart: async (task, _agentId, attempt) => {
                setGoalCurrentStep(task.id);
                setGoalSteps((prev) =>
                  prev.map((s) =>
                    s.id === task.id
                      ? {
                        ...s,
                        status: "running",
                        attempt,
                        gateStatus: undefined,
                        todos: s.todos?.map((t) => ({ ...t, status: "running" })),
                      }
                      : s
                  )
                );
              },
              onTaskProgress: async (task, _attempt, status, durationMs, toolcallsCount) => {
                setGoalSteps((prev) =>
                  prev.map((s) =>
                    s.id === task.id ? { ...s, toolcallsCount, durationMs, progressStatus: status } : s
                  )
                );
              },
              onGateRun: async (taskId) => {
                setGoalSteps((prev) =>
                  prev.map((s) => (s.id === taskId ? { ...s, gateStatus: "running" } : s))
                );
              },
              onGateResult: async (taskId, passed) => {
                setGoalSteps((prev) =>
                  prev.map((s) =>
                    s.id === taskId ? { ...s, gateStatus: passed ? "passed" : "failed" } : s
                  )
                );
              },
              onTaskComplete: async (task, durationMs, toolcallsCount) => {
                setGoalSteps((prev) =>
                  prev.map((s) =>
                    s.id === task.id
                      ? {
                        ...s,
                        status: "done",
                        durationMs,
                        toolcallsCount,
                        todos: s.todos?.map((t) => ({ ...t, status: "done" })),
                      }
                      : s
                  )
                );
              },
              onTaskFailure: async (task) => {
                setGoalSteps((prev) =>
                  prev.map((s) =>
                    s.id === task.id
                      ? {
                        ...s,
                        status: "error",
                        todos: s.todos?.map((t) =>
                          t.status === "running" ? { ...t, status: "error" } : t
                        ),
                      }
                      : s
                  )
                );
              }
            });

            addSystemLines([`✓ Goal complete: ${taskDesc}`]);
          } catch (err) {
            addSystemLines([
              `Goal error: ${err instanceof Error ? err.message : String(err)}`,
            ]);
          } finally {
            setGoalActive(false);
            setLoading(false);
          }
        })();
      }
      if (slash.scheduleTask) {
        const raw = slash.scheduleTask;
        (async () => {
          try {
            const { addSchedule, everyFlagToCron, schedulesPath, isWorkflowName } = await import("@agency/core");
            // Parse "every 30m do something" → cron + task
            const everyMatch = raw.match(/^every\s+(\S+)\s+(.+)$/i);
            if (!everyMatch) {
              addSystemLines(["Could not parse schedule. Use: /schedule every 30m <task>"]);
              return;
            }
            const cronExpr = everyFlagToCron(everyMatch[1]!);
            const taskBody = everyMatch[2]!;
            // Map task to workflow name if possible, default to "review"
            const words = taskBody.toLowerCase().split(/\s+/);
            const workflow = words.find((w) => isWorkflowName(w)) ?? "review";
            const entry = addSchedule(project, {
              workflow: workflow as any,
              cron: cronExpr,
              projectRoot: project,
            });
            addSystemLines([
              `⏲ Schedule added: "${taskBody.slice(0, 50)}" (${entry.id})`,
              `  workflow: ${workflow} · cron: ${cronExpr} · file: ${schedulesPath(project)}`,
            ]);
          } catch (err) {
            const errorMsg = `Schedule error: ${err instanceof Error ? err.message : String(err)}`;
            pushError(errorMsg);
            addSystemLines([errorMsg]);
          }
        })();
      }
      if (slash.showAgents) {
        closeAllOverlays();
        setOverlayOpen("agents", true);
      }
      if (slash.runIndex) {
        (async () => {
          const controller = new AbortController();
          indexAbortControllerRef.current = controller;
          try {
            const { incrementalUpdateAsync, writeIndex, buildKnowledgeGraph } = await import("@agency/core");
            setIndexing(true);
            const index = await incrementalUpdateAsync(project, {
              onProgress: (p) => setIndexProgress(p),
              signal: controller.signal,
            });
            if (controller.signal.aborted) {
              return;
            }
            writeIndex(project, index);
            
            // Build the knowledge graph and generate HTML dashboard
            await buildKnowledgeGraph(project);
            const langSummary = index.stats?.languages
              ? Object.entries(index.stats.languages)
                .sort((a, b) => b[1] - a[1])
                .slice(0, 5)
                .map(([lang, count]) => `${lang}:${count}`)
                .join(" ")
              : "";
            addSystemLines([
              `✦ Indexed ${index.files.length} files (${index.stats?.indexDurationMs ?? 0}ms)`,
              langSummary ? `  ${langSummary}` : "",
            ].filter(Boolean));
          } catch (err) {
            if (controller.signal.aborted) return;
            addSystemLines([`Index error: ${err instanceof Error ? err.message : String(err)}`]);
          } finally {
            if (indexAbortControllerRef.current === controller) {
              setIndexing(false);
              setIndexProgress(null);
              indexAbortControllerRef.current = null;
            }
          }
        })();
      } else if (slash.systemLines?.length) {
        addSystemLines(slash.systemLines);
      }

    },
    [addSystemLines, closeAllOverlays, exit, project, session, themeId, updateSession, pushError]
  );

  const processNextInQueue = useCallback(async () => {
    if (processingRef.current) return;
    if (pendingApproval || hasPendingApprovalRef.current) return;

    if (promptQueueRef.current.length === 0) {
      setLoading(false);
      setActivityPhase("idle");
      return;
    }

    const prompt = promptQueueRef.current.shift()!;
    processingRef.current = true;
    setLoading(true);

    try {
      if (parseSlashCommand(prompt)) {
        updateSession((s) =>
          appendMessages(s, [{ role: "user", content: prompt }])
        );
        await runSlash(prompt);
        return;
      }

      if (prompt.startsWith("!")) {
        const cmd = prompt.slice(1).trim();
        if (!cmd) return;
        updateSession((s) =>
          appendMessages(s, [{ role: "user", content: prompt }])
        );

        const { runShellCommand, requiresApproval } = await import("@agency/core");
        if (requiresApproval(cmd) && !autoApproveRef.current) {
          setPendingApproval({
            toolName: "shell",
            shellCommand: cmd,
            purpose: "Execute shell command from TUI",
            safetyPolicy: "destructive or mutating — requires explicit approval",
          });
          return;
        }
        try {
          // Reaching here means the command is safe OR auto-approve is on —
          // either way it is approved, so forward yes:true past the gate.
          const result = await runShellCommand(project, cmd, {
            yes: true,
            capture: true,
          });
          const out =
            [result.stdout, result.stderr].filter(Boolean).join("\n").trim() ||
            `(exit ${result.exitCode})`;
          addShellExecution(cmd, out);
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          addShellExecution(cmd, `Error: ${errMsg}`);
        }
        return;
      }

      // Phase 3: inject skill prefix based on agent mode
      let finalPrompt = prompt;
      const envRoot = process.env.AGENCY_SKILLS_ROOT?.trim();
      const skillsRoot = envRoot || resolveSkillsRoot();

      if (agentMode === "plan") {
        const hasPlanSkill = existsSync(join(skillsRoot, "codex-plan-writer", "SKILL.md"));
        if (hasPlanSkill && !prompt.startsWith("$")) {
          finalPrompt = `$plan ${prompt}`;
        } else if (!prompt.startsWith("[")) {
          finalPrompt = `[PLANNING MODE — Focus on architecture, design, and step-by-step implementation plan] ${prompt}`;
        }
      } else if (agentMode === "debug") {
        const hasDebugSkill = existsSync(join(skillsRoot, "codex-systematic-debugging", "SKILL.md"));
        if (hasDebugSkill && !prompt.startsWith("$")) {
          finalPrompt = `$debug ${prompt}`;
        } else if (!prompt.startsWith("[")) {
          finalPrompt = `[REVIEW MODE — Focus on systematic root cause analysis, debugging, and step-by-step fixes] ${prompt}`;
        }
      } else if (agentMode === "ask") {
        if (!prompt.startsWith("[")) {
          finalPrompt = `[READ-ONLY MODE — answer questions only, do not edit files] ${prompt}`;
        }
      }

      const assistantId = newMessageId();
      updateSession((s) =>
        appendMessages(s, [
          { role: "user", content: prompt },
          {
            id: assistantId,
            role: "assistant",
            content: "",
            streaming: true,
          },
        ])
      );

      setLoadStartMs(Date.now());
      setTokenCount(0);
      setActivityPhase("routing");

      try {
        let gotDelta = false;
        const budget = modeBudget(agentMode);

        let accumulatedContent = "";
        let accumulatedThought = "";
        let lastFlushMs = Date.now();
        let flushTimeout: NodeJS.Timeout | null = null;
        let tokenCountIncrement = 0;

        const flushStream = () => {
          if (accumulatedContent || accumulatedThought || tokenCountIncrement > 0) {
            setTokenCount((c) => c + tokenCountIncrement);
            tokenCountIncrement = 0;

            const cDelta = accumulatedContent;
            const tDelta = accumulatedThought;
            accumulatedContent = "";
            accumulatedThought = "";

            patchMessage(assistantId, (m) => {
              const nextPatch: Partial<SessionMessage> = {};
              if (cDelta) nextPatch.content = m.content + cDelta;
              if (tDelta) nextPatch.thought = (m.thought || "") + tDelta;
              return nextPatch;
            }, false);

            lastFlushMs = Date.now();
          }
        };

        const triggerThrottledFlush = () => {
          const now = Date.now();
          const throttleInterval = getThrottleInterval();
          if (now - lastFlushMs >= throttleInterval) {
            flushStream();
            if (flushTimeout) {
              clearTimeout(flushTimeout);
              flushTimeout = null;
            }
          } else if (!flushTimeout) {
            flushTimeout = setTimeout(() => {
              flushStream();
              flushTimeout = null;
            }, throttleInterval - (now - lastFlushMs));
          }
        };

        // Create AbortController for this request
        const controller = new AbortController();
        abortRef.current = controller;

        const selectedProviderId = displayModelName.split("/")[0] as ProviderId;

        const history = (session?.messages || [])
          .filter((m) => m.role === "user" || m.role === "assistant")
          .map((m) => ({
            role: m.role as "user" | "assistant",
            content: m.content,
          }));

        // verify-main-turn in the TUI: when `verifyMainTurn` is on, the turn
        // self-heals after a file edit (re-runs with the build/lint errors fed
        // back) instead of leaving a broken edit. Each self-heal round REPLACES
        // the previous round's streamed text (round N is the corrected version,
        // not an addition), so reset the live buffer + message when a new round
        // begins, and surface it as a system line so the re-run isn't a silent
        // mysterious re-stream. Off (flags) → `runChatTurnWithVerify` delegates
        // straight to `runChatTurnWithStream`, byte-identical.
        const onSelfHeal = (event: any) => {
          const payload = typeof event.payload === "string" ? JSON.parse(event.payload) : event.payload;
          accumulatedContent = "";
          accumulatedThought = "";
          if (flushTimeout) { clearTimeout(flushTimeout); flushTimeout = null; }
          patchMessage(assistantId, { content: "", thought: "" }, false);
          addSystemLines([`⚙ Verification failed — self-healing (round ${payload?.round ?? 2})…`]);
        };
        EventBus.getInstance().subscribe("chat:self-healing", onSelfHeal);

        let result: Awaited<ReturnType<typeof runChatTurnWithVerify>>;
        try {
          result = await runChatTurnWithVerify(
          {
            prompt: finalPrompt,
            projectRoot: project,
            skillsRoot,
            budget,
            providerId: selectedProviderId,
            signal: controller.signal,
            history,
            sessionId: session?.id,
          },
          {
            onRoute: (ev) => {
              setLastRouteProvider(ev.route.provider);
              if (!activeModelName) {
                setActiveModelName(
                  ev.route.provider +
                  (agencyConfig.providers[ev.route.provider]?.model
                    ? `/${agencyConfig.providers[ev.route.provider]!.model}`
                    : "")
                );
              }
              setActivityPhase("writing");
              patchMessage(assistantId, {
                presentation: {
                  chips: ev.chips,
                  suggestions: [],
                  cacheHint: ev.routeFromCache ? "cached" : undefined,
                },
                streaming: !ev.routeOnly,
              });
              if (ev.routeOnly) {
                setActivityPhase("idle");
              }
            },
            onDelta: (delta) => {
              if (!gotDelta) {
                gotDelta = true;
                setActivityPhase("writing");
              }
              accumulatedContent += delta;
              tokenCountIncrement += 1;
              triggerThrottledFlush();
            },
            onThought: (thoughtDelta) => {
              accumulatedThought += thoughtDelta;
              triggerThrottledFlush();
            },
          }
          );
        } finally {
          EventBus.getInstance().unsubscribe("chat:self-healing", onSelfHeal);
        }

        if (flushTimeout) {
          clearTimeout(flushTimeout);
        }
        flushStream();

        const turn = toPresentationTurn(result);
        patchMessage(assistantId, {
          content: turn.body || undefined,
          presentation: {
            chips: turn.chips,
            suggestions: turn.suggestions,
            cacheHint: turn.cacheHint,
          },
          streaming: false,
        });

        if (result.completionMetadata) {
          setLastUsage(result.completionMetadata);
        }

        if (agentMode !== "ask") {
          const fileEdits = parseFileEditSuggestions(result.assistantText, project);
          if (fileEdits.length > 0) {
            pendingFileEditsRef.current = fileEdits;
            hasPendingApprovalRef.current = true;
            showNextFileEditApprovalRef.current();
            return;
          }
        }

      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        pushError(errorMsg);
        updateSession((s) =>
          appendMessages(s, [
            {
              role: "system",
              content: errorMsg,
            },
          ])
        );
      }
    } catch (err) {
      const errorMsg = `Queue error: ${err instanceof Error ? err.message : String(err)}`;
      pushError(errorMsg);
      addSystemLines([errorMsg]);
    } finally {
      processingRef.current = false;
      void processNextInQueue();
    }
  }, [
    addSystemLines,
    agencyConfig,
    displayModelName,
    activeModelName,
    project,
    runSlash,
    updateSession,
    agentMode,
    patchMessage,
  ]);

  const executeFileWrite = useCallback((filePath: string, fileContent: string) => {
    void (async () => {
      setLoading(true);
      try {
        const { writeFileSync, mkdirSync } = await import("node:fs");
        const { dirname, resolve } = await import("node:path");

        const absolutePath = resolve(project, filePath);

        mkdirSync(dirname(absolutePath), { recursive: true });
        writeFileSync(absolutePath, fileContent, "utf8");

        try {
          const { buildIndex, writeIndex } = await import("@agency/core");
          const index = buildIndex(project);
          writeIndex(project, index);
          addSystemLines([
            `✓ Successfully wrote file: ${filePath}`,
            `✓ Automatically re-indexed workspace`
          ]);
        } catch (indexErr) {
          addSystemLines([
            `✓ Successfully wrote file: ${filePath}`,
            `⚠ Workspace indexing failed: ${indexErr instanceof Error ? indexErr.message : String(indexErr)}`
          ]);
        }
      } catch (err) {
        addSystemLines([
          `Error writing file ${filePath}: ${err instanceof Error ? err.message : String(err)}`
        ]);
      } finally {
        setLoading(false);
        pendingFileEditsRef.current.shift();
        showNextFileEditApprovalRef.current();
      }
    })();
  }, [project, addSystemLines]);

  const showNextFileEditApproval = useCallback(() => {
    const queue = pendingFileEditsRef.current;
    if (queue.length === 0) {
      hasPendingApprovalRef.current = false;
      void processNextInQueue();
      return;
    }

    const edit = queue[0];
    if (autoApproveRef.current) {
      executeFileWrite(edit.filePath, edit.content);
      return;
    }

    setPendingApproval({
      toolName: "file_writer",
      purpose: `Write/edit file: ${edit.filePath}`,
      safetyPolicy: `Mutates local codebase file ${edit.filePath} — requires approval`,
      fileWritePath: edit.filePath,
      fileWriteContent: edit.content,
    });
  }, [processNextInQueue, executeFileWrite]);

  useEffect(() => {
    showNextFileEditApprovalRef.current = showNextFileEditApproval;
  }, [showNextFileEditApproval]);

  const handleSubmit = useCallback(async () => {
    const prompt = buffer.trim();
    if (!prompt) return;
    setBuffer("");
    setSubagents([]);
    setActiveSubagentId(null);
    // A new turn starts fresh: drop the previous turn's plan so a stale/
    // completed checklist doesn't linger above the composer.
    setPlanTodos([]);

    autoApproveRef.current = false;
    userHasScrolledUpRef.current = false;
    promptQueueRef.current.push(prompt);
    void processNextInQueue();
  }, [buffer, processNextInQueue]);

  const clearApproval = useCallback(
    (decision: "approve" | "deny") => {
      const pending = pendingApproval;
      if (pending) {
        onApprovalDecision?.(decision, pending);
      }
      terminalBell();
      setPendingApproval(null);


      if (decision === "approve" && pending?.shellCommand) {
        const cmd = pending.shellCommand;
        void (async () => {
          setLoading(true);
          try {
            const { runShellCommand } = await import("@agency/core");
            const result = await runShellCommand(project, cmd, {
              yes: true,
              capture: true,
            });
            const out =
              [result.stdout, result.stderr]
                .filter(Boolean)
                .join("\n")
                .trim() || `(exit ${result.exitCode})`;
            addShellExecution(cmd, out);
          } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            addShellExecution(cmd, `Error: ${errMsg}`);
          } finally {
            setLoading(false);
            void processNextInQueue();
          }
        })();
      } else if (decision === "approve" && pending?.toolName === "file_writer" && pending.fileWritePath && pending.fileWriteContent !== undefined) {
        executeFileWrite(pending.fileWritePath, pending.fileWriteContent);
      } else {
        if (pending?.toolName === "file_writer") {
          pendingFileEditsRef.current.shift();
          showNextFileEditApprovalRef.current();
        } else {
          hasPendingApprovalRef.current = false;
          void processNextInQueue();
        }
      }

    },
    [addSystemLines, onApprovalDecision, pendingApproval, project, processNextInQueue, executeFileWrite]
  );

  const splashDoneRef = useRef(() => setPhase("welcome"));
  useEffect(() => {
    splashDoneRef.current = () => setPhase("welcome");
  });



  const handleDeleteSession = useCallback((id: string) => {
    deleteSession(project, id);
    const updated = listSessionSummaries(project);
    setSessionSummaries(updated);
    setSessionDeletingId(null);
    setResumeIndex((prev) => Math.max(0, Math.min(prev, updated.length - 1)));
    addSystemLines([`✓ Deleted session ${id}`]);
  }, [project, addSystemLines]);

  const handleWelcomeAction = useCallback((index: number) => {
    if (index === 0) {
      // new worktree
      const fresh = createSession(project);
      setSession(fresh);
      setPhase("main");
    } else if (index === 1) {
      // resume session
      setSessionSummaries(listSessionSummaries(project));
      setResumeIndex(0);
      setOverlayOpen("resume", true);
    } else if (index === 2) {
      // quit
      safeExit();
    }
  }, [project, safeExit]);

  // Mouse hook will be initialized after layout parameters are computed below.

  // Auto-index on transition to main phase
  useEffect(() => {
    if (phase !== "main") return;
    let active = true;
    const controller = new AbortController();
    indexAbortControllerRef.current = controller;
    (async () => {
      try {
        const { isIndexStale, incrementalUpdateAsync, writeIndex } = await import("@agency/core");
        if (!isIndexStale(project)) {
          // Index already exists and is fresh → genuinely ready.
          if (active) setIndexReady(true);
        } else {
          if (!active) return;
          setIndexing(true);
          const index = await incrementalUpdateAsync(project, {
            onProgress: (p) => {
              if (active) setIndexProgress(p);
            },
            signal: controller.signal,
          });
          if (!active) return;
          if (controller.signal.aborted) return;
          writeIndex(project, index);
          if (active) setIndexReady(true);
          addSystemLines([
            `✦ Indexed ${index.files.length} files (${index.stats?.indexDurationMs ?? 0}ms)`,
          ]);
        }
      } catch {
        // Silent fail — indexing is best-effort
      } finally {
        if (active && indexAbortControllerRef.current === controller) {
          setIndexing(false);
          setIndexProgress(null);
          indexAbortControllerRef.current = null;
        }
      }
    })();
    return () => {
      active = false;
      controller.abort();
    };
  }, [phase, project, addSystemLines]);


  const showApproval = pendingApproval !== null;

  const menuActive = (slashActive && slashSuggestions.length > 0) || (atActive && atSuggestions.length > 0);
  const composerHeight = showApproval || overlayActive || activeSubagentId !== null
    ? 0
    : estimateComposerHeight(buffer, contentCols, loading);
  const baseFixedHeight = 2 + 1 + composerHeight + 1; // Header (2) + Divider (1) + Composer + Footer (1)

  const suggestionsHeight = menuActive ? 9 : 0;
  // ToolActivity renders one row + a marginTop blank line (2 total), and only
  // when NOT in a goal (the GoalRunner already shows live activity — showing the
  // spinner too is redundant and was never height-reserved during goals).
  const loadingHeight = loading && !goalActive ? 2 : 0;
  const indexingHeight = indexing ? 3 : 0;
  // ErrorBanner (bordered) renders below the conversation; reserve its height so
  // it can't overflow + clip the layout. Estimate: border(2)+header(1)+
  // marginTop(1)+message(2)+marginBottom(1), +2 when several errors stack.
  const activeErrorCount = errorNotifications.filter((e) => !e.dismissed).length;
  const errorBannerHeight = activeErrorCount > 0 ? 7 + (activeErrorCount > 1 ? 2 : 0) : 0;

  // We want conversationHeight to be at least 4
  const minConversationHeight = 4;

  // Available height for GoalRunner
  const goalRunnerBaseHeight = goalActive ? (goalRunnerViewMode === "flat" ? 2 : 6) : 0;

  let computedMaxVisibleSteps = 8;
  if (goalActive) {
    const allocatedOtherHeight = baseFixedHeight + suggestionsHeight + loadingHeight + indexingHeight + goalRunnerBaseHeight;
    const remainingForStepsAndChat = rows - allocatedOtherHeight - 1;
    // We want at least minConversationHeight for chat, so:
    const stepsBudget = Math.max(2, remainingForStepsAndChat - minConversationHeight);
    computedMaxVisibleSteps = Math.max(2, Math.min(8, stepsBudget));
  }
  const goalRunnerHeight = goalActive ? (goalRunnerViewMode === "flat" ? 2 : 6) + computedMaxVisibleSteps : 0;

  // The live PlanPanel (update_plan) renders below the conversation, so its
  // height MUST be reserved here — otherwise conversationHeight is over-counted,
  // the panel overflows the viewport, and ink clips it (a "0/6" plan showed only
  // 3-4 of its rows). Shows only while the plan has unfinished work (PlanPanel
  // auto-hides once every step is completed), capped so a long plan can't eat
  // the whole conversation.
  const planActive = !goalActive && planTodos.some((t) => t.status !== "completed");
  let planMaxVisible = 0;
  let planPanelHeight = 0;
  if (planActive) {
    const planOverhead = 3; // round border (2) + "Plan N/M" header (1)
    const allocatedOther =
      baseFixedHeight + suggestionsHeight + loadingHeight + indexingHeight;
    const planBudget = rows - allocatedOther - 1 - minConversationHeight - planOverhead;
    planMaxVisible = Math.max(2, Math.min(12, planBudget));
    const truncated = planTodos.length > planMaxVisible;
    const visibleRows = truncated ? planMaxVisible : planTodos.length;
    planPanelHeight = planOverhead + visibleRows + (truncated ? 1 : 0);
  }

  const fixedHeight = baseFixedHeight + suggestionsHeight + loadingHeight + goalRunnerHeight + indexingHeight + planPanelHeight + errorBannerHeight;
  const conversationHeight = Math.max(4, rows - fixedHeight - 1);

  useKeyboardHandlers({
    overlays,
    setOverlays,
    expandedTui,
    setExpandedTui,
    scrollOffset,
    setScrollOffset,
    activeSubagentId,
    setActiveSubagentId,
    transcriptNav,
    transcriptFocus,
    setTranscriptFocus,
    userHasScrolledUpRef,
    phase,
    setPhase,
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
    toggleOverlay,
    overlayActive,
  });

  // Auto-scroll logic when conversation height or virtualLinesCount changes
  useEffect(() => {
    const maxOffset = getMaxScrollOffset(virtualLinesCount, conversationHeight, survivalModeActive);

    // Snapping behavior: if user scroll is within 2 lines of the bottom, auto-snap to end on new content
    setScrollOffset((offset) => {
      const distance = maxOffset - offset;
      if (distance <= 2) {
        userHasScrolledUpRef.current = false;
        return maxOffset;
      }

      // If they are viewing deep history (> 2 lines up), maintain stable scroll positioning
      if (!userHasScrolledUpRef.current) {
        return maxOffset;
      } else {
        return Math.min(offset, maxOffset);
      }
    });
  }, [virtualLinesCount, conversationHeight, survivalModeActive]);

  // Automatically scroll to bottom when active loading or goal progress starts/executes
  const activeExecution = loading || goalActive;
  const prevActiveExecutionRef = useRef(false);

  useEffect(() => {
    if (activeExecution && !prevActiveExecutionRef.current) {
      userHasScrolledUpRef.current = false;
      const maxOffset = getMaxScrollOffset(virtualLinesCount, conversationHeight, survivalModeActive);
      setScrollOffset(maxOffset);
    }
    prevActiveExecutionRef.current = activeExecution;
  }, [activeExecution, survivalModeActive, virtualLinesCount, conversationHeight]);

  // Mouse wheel is handled entirely by the terminal: `enterAlternateScreen`
  // enables alternate-scroll mode (?1007h), so Windows Terminal / xterm translate
  // the wheel into ↑/↓ arrow keys that the keyboard handler already scrolls on.
  // No in-JS mouse tracking is enabled, so there is no click/scroll parser here.
  // (To restore click-to-select on overlays, re-enable ?1000h/?1006h in
  // enterAlternateScreen and reinstate an SGR parser on Ink's internal_eventEmitter.)

  const skillsLabel = useMemo(() => {
    try {
      return resolveSkillsRoot();
    } catch {
      return process.env.AGENCY_SKILLS_ROOT?.trim();
    }
  }, []);

  const statusBarWorkers = useMemo(() => {
    const list = subagents.map((s) => ({
      name: normalizeWorkerName(s.agentId),
      status: s.status === "running" ? "active" as const : s.status === "queued" ? "idle" as const : "done" as const,
    }));
    if (mcpConnecting) {
      list.unshift({
        name: "MCP connecting",
        status: "active" as const,
      });
    }
    return list;
  }, [subagents, mcpConnecting]);

  if (phase === "splash") {
    return (
      <TerminalViewport theme={theme}>
        <Splash
          theme={theme}
          version="0.1.0"
          project={project}
          skillsPath={skillsLabel}
          onDone={() => splashDoneRef.current()}
        />
      </TerminalViewport>
    );
  }

  if (phase === "welcome") {
    if (overlays.resume) {
      return (
        <TerminalViewport theme={theme}>
          <Box
            flexDirection="column"
            height="100%"
            width="100%"
            alignItems="center"
            justifyContent="center"
          >
            <SessionPicker
              theme={theme}
              sessions={sessionSummaries}
              index={resumeIndex}
              setIndex={setResumeIndex}
              deletingId={sessionDeletingId}
              setDeletingId={setSessionDeletingId}
              onSelect={(s) => {
                const loaded = loadSession(project, s.id);
                if (loaded) {
                  setSession(loaded);
                  setPlanTodos([]);
                  addSystemLines([`Resumed session ${s.id} (${s.messageCount} messages)`]);
                }
                setOverlayOpen("resume", false);
                setPhase("main");
              }}
              onClose={() => setOverlayOpen("resume", false)}
              onDelete={handleDeleteSession}
            />
          </Box>
        </TerminalViewport>
      );
    }

    return (
      <TerminalViewport theme={theme}>
        <WelcomeMenu
          theme={theme}
          version="0.1.0"
          selectedIndex={welcomeIndex}
          rows={rows}
          cols={cols}
        />
      </TerminalViewport>
    );
  }

  const modelHint = lastRouteProvider ?? undefined;



  const statusHint = showApproval
    ? "y approve · a auto-approve · n deny"
    : activeSubagentId !== null
      ? "↑ parent up · ←→ switch workers · Esc close"
      : overlays.help
        ? "? close · Esc exit"
        : overlays.connect
          ? "↑↓ navigate · Enter confirm · Esc close"
          : overlays.models
            ? "↑↓ browse · Enter select · Esc close"
            : overlays.skills
              ? "↑↓ browse · Enter inject · Esc close"
              : overlays.variant
                ? "↑↓ browse · Enter select · Esc close"
                : overlayActive
                  ? "↑↓ navigate · Esc close"
                  : undefined;

  const maxVisibleModels = Math.max(4, Math.min(10, rows - 14));
  const maxVisiblePlugins = Math.max(4, Math.min(12, rows - 15));

  return (
    <TerminalViewport theme={theme}>
      <Shell
        theme={theme}
        project={project}
        modelHint={modelHint}
        modelName={displayModelName}
        thinkingLabel={thinkingLabel}
        loading={loading}
        composer={
          showApproval || overlayActive || activeSubagentId !== null ? null : (
            <ComposerBlock
              theme={theme}
              buffer={buffer}
              cursorPos={composerCursorEdit ? cursorPos : undefined}
              onBufferChange={setBuffer}
              loading={loading}
              showHelp={overlays.help}
              slashQuery={slashActive?.query ?? null}
              slashSuggestions={slashSuggestions}
              atQuery={atActive?.query ?? null}
              atSuggestions={atSuggestions}
              agentMode={agentMode}
              displayModelName={displayModelName}
              budgetMode={modeBudget(agentMode)}
              thinkingLabel={thinkingLabel}
              project={project}
            />
          )
        }
        footer={
          <StatusBar
            theme={theme}
            sessionId={session.id}
            themeId={themeId}
            hint={statusHint}
            loading={loading}
            contextPercent={contextUsage.percent}
            modelName={displayModelName}
            budgetMode={modeBudget(agentMode)}
            hasRoutingWeights={hasRoutingWeights}
            thinkingLabel={thinkingLabel}
            modeLabel={modeLabel(agentMode)}
            modeDescription={modeDescription(agentMode)}
            phaseLabel={activityPhase !== "idle" ? getPhaseLabel(activityPhase) : undefined}
            agentMode={agentMode}
            workers={statusBarWorkers}
          />
        }
      >
        {showApproval ? (
          <Approval pending={pendingApproval} theme={theme} width={composerWidth} />
        ) : activeSubagentId !== null ? (() => {
          const subagent = subagents.find((s) => s.agentId === activeSubagentId);
          if (!subagent) return <Text color={theme.danger}>Subagent not found</Text>;

          const subagentIndex = subagents.findIndex((s) => s.agentId === activeSubagentId);
          const totalSubagents = subagents.length;

          // Limit task description text length to avoid breaking layout borders
          const truncatedTask = subagent.task.length > composerWidth - 8
            ? subagent.task.substring(0, composerWidth - 11) + "..."
            : subagent.task;

          // Compute remaining height for steps and logs
          // Outer box takes: 4 rows (border & padding)
          // Header takes: 2 rows
          // Task description takes: 2 rows
          // Thought process (if present) takes: 1 row
          // Navigation hint takes: 3 rows
          // So fixed height inside outer box = 7 rows (8 if thought is present)
          // Available height inside outer box = rows - 4 - 4
          const availableInnerHeight = rows - 4 - 4;
          const detailFixedRows = subagent.thought ? 8 : 7;
          const remainingForStepsAndOutput = Math.max(4, availableInnerHeight - detailFixedRows);

          // Allocate 40% to steps, 60% to output
          const stepsHeight = Math.max(2, Math.floor(remainingForStepsAndOutput * 0.4));
          const outputHeight = Math.max(2, remainingForStepsAndOutput - stepsHeight);

          // Limit steps shown in WorkerProgress
          const visibleSteps = subagent.steps ? subagent.steps.slice(-stepsHeight) : [];

          // Limit output text lines
          let outputLines: string[] = [];
          if (subagent.text) {
            outputLines = subagent.text.split("\n");
            if (outputLines.length > outputHeight) {
              outputLines = outputLines.slice(-outputHeight);
            }
          }

          return (
            <Box flexDirection="column" width={composerWidth} padding={1} borderStyle="double" borderColor={theme.accent}>
              {/* Header */}
              <Box flexDirection="row" justifyContent="space-between" marginBottom={1}>
                <Text color={theme.accent} bold>
                  worker.{subagent.agentId} — {subagent.status}
                </Text>
                <Text color={theme.muted}>
                  Explore ({subagentIndex + 1} of {totalSubagents})
                </Text>
              </Box>

              {/* Task */}
              <Box flexDirection="column" marginBottom={1}>
                <Text color={theme.muted} bold>Task Description:</Text>
                <Text color={theme.text} wrap="truncate">{truncatedTask}</Text>
              </Box>

              {/* Thought process (Streaming or static) */}
              {subagent.thought ? (
                <Box flexDirection="column" marginBottom={1}>
                  <Text color={theme.warning} italic wrap="truncate">Thought: {subagent.thought}</Text>
                </Box>
              ) : null}

              {/* Steps & Findings checklist */}
              <Box flexDirection="column" marginBottom={1}>
                <Text color={theme.muted} bold>Execution Steps & Tool Operations:</Text>
                {visibleSteps.length > 0 ? (
                  <WorkerProgress theme={theme} steps={visibleSteps} />
                ) : (
                  <Text color={theme.muted} dimColor>No steps logged yet</Text>
                )}
              </Box>

              {/* Real-time Streaming stdout/text response */}
              {outputLines.length > 0 ? (
                <Box flexDirection="column" marginBottom={1}>
                  <Text color={theme.muted} bold>Current Output / Findings Summary:</Text>
                  {outputLines.map((line, idx) => (
                    <Text key={idx} color={theme.success} wrap="truncate">{line}</Text>
                  ))}
                </Box>
              ) : null}

              {/* Bottom Navigation hint */}
              <Box flexDirection="row" justifyContent="space-between" marginTop={1} borderStyle="single" borderColor={theme.dimBorder} paddingX={1}>
                <Text color={theme.muted}>esc back · ctrl+c quit</Text>
                <Text color={theme.accent} bold>Parent up · Prev left · Next right</Text>
              </Box>
            </Box>
          );
        })() : overlayActive ? (
          <Box
            flexGrow={1}
            alignItems="center"
            justifyContent="center"
            flexDirection="column"
          >
            {overlays.help ? (
              <HelpOverlay theme={theme} cols={cols} onClose={() => setOverlayOpen("help", false)} />
            ) : null}
            {overlays.connect ? (
              <ConnectOverlay
                theme={theme}
                providers={providerStatuses}
                onSelect={() => { }}
                profiles={agencyConfig.providers}
                onSaveKey={(providerId, apiKey, extraProfile) => {
                  import("node:fs").then(({ readFileSync, mkdirSync, existsSync: fsExists }) => {
                    import("node:os").then(({ homedir }) => {
                      import("node:path").then(({ join: pjoin }) => {
                        const dir = pjoin(homedir(), ".agency");
                        if (!fsExists(dir)) mkdirSync(dir, { recursive: true });
                        const cfgPath = pjoin(dir, "config.json");
                        let cfg: Record<string, unknown> = {};
                        try {
                          cfg = JSON.parse(readFileSync(cfgPath, "utf8")) as Record<string, unknown>;
                        } catch { /* new file */ }
                        const providers = (cfg.providers ?? {}) as Record<string, Record<string, any>>;

                        const trimmedKey = apiKey.trim();
                        if (!trimmedKey && !extraProfile) {
                          if (providers[providerId]) {
                            delete providers[providerId].apiKey;
                            if (Object.keys(providers[providerId]).length === 0) {
                              delete providers[providerId];
                            }
                          }
                          cfg.providers = providers;
                          saveAgencyConfig(cfg as any, cfgPath);
                          setAgencyConfig(loadAgencyConfig());
                          addSystemLines([`✗ Disconnected provider ${providerId}`]);
                        } else {
                          const existing = providers[providerId] ?? {};
                          const updated = {
                            ...existing,
                            ...(trimmedKey ? { apiKey: trimmedKey } : {}),
                            ...extraProfile
                          };
                          if (!trimmedKey && updated.apiKey) {
                            delete updated.apiKey;
                          }
                          providers[providerId] = updated;
                          cfg.providers = providers;

                          // Automatically switch defaultProvider and active model
                          cfg.defaultProvider = providerId;
                          let modelName = extraProfile?.model || updated.model;
                          if (!modelName) {
                            if (providerId === "local") modelName = "llama3.2";
                            else if (providerId === "openai") modelName = "gpt-4o-mini";
                            else if (providerId === "anthropic") modelName = "claude-3-5-sonnet-20241022";
                            else if (providerId === "google") modelName = "gemini-2.0-flash";
                            else if (providerId === "nvidia") modelName = "meta/llama3-70b-instruct";
                            else if (providerId === "openrouter") modelName = "meta-llama/llama-3-70b-instruct";
                            else modelName = "default";
                          }
                          if (!providers[providerId]) providers[providerId] = {};
                          providers[providerId].model = modelName;
                          cfg.providers = providers;

                          saveAgencyConfig(cfg as any, cfgPath);
                          setAgencyConfig(loadAgencyConfig());
                          setActiveModelName(`${providerId}/${modelName}`);

                          // Re-fetch the model list now that a key was added, so the
                          // provider's live models (e.g. NVIDIA NIM's /models) are
                          // ready the moment the user opens /models — instead of
                          // waiting for the next manual refresh. Best-effort.
                          setModelsLoading(true);
                          import("@agency/providers").then(({ listAllModels }) => {
                            listAllModels()
                              .then((models) => {
                                setAvailableModels(models);
                                setModelsLoading(false);
                              })
                              .catch(() => setModelsLoading(false));
                          }).catch(() => setModelsLoading(false));

                          // Warn (don't block) when a raw secret is stored on disk —
                          // recommend the ${ENV_VAR} placeholder form instead.
                          const storedRawKey =
                            trimmedKey && !trimmedKey.startsWith("${");
                          addSystemLines([
                            `✓ Profile configured for ${providerId}`,
                            `✓ Switched default provider to ${providerId}`,
                            `✓ Set active model to ${providerId}/${modelName}`,
                            ...(storedRawKey
                              ? [
                                  `▲ Stored a raw API key in ~/.agency/config.json. For better safety, set it to \${${providerId.toUpperCase()}_API_KEY} and export that environment variable instead.`,
                                ]
                              : []),
                          ]);
                        }

                      });
                    });
                  });
                }}
                onClose={() => setOverlayOpen("connect", false)}
              />
            ) : null}
            {overlays.models ? (
              <ModelsOverlay
                theme={theme}
                models={availableModels}
                currentModel={displayModelName}
                loading={modelsLoading}
                maxVisible={maxVisibleModels}
                onSelect={(model) => {
                  import("node:fs").then(({ readFileSync, writeFileSync, mkdirSync, existsSync: fsExists }) => {
                    import("node:os").then(({ homedir }) => {
                      import("node:path").then(({ join: pjoin }) => {
                        const dir = pjoin(homedir(), ".agency");
                        if (!fsExists(dir)) mkdirSync(dir, { recursive: true });
                        const cfgPath = pjoin(dir, "config.json");
                        let cfg: Record<string, any> = {};
                        try {
                          cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
                        } catch { /* new file */ }
                        cfg.defaultProvider = model.provider;
                        if (!cfg.providers) cfg.providers = {};
                        if (!cfg.providers[model.provider]) cfg.providers[model.provider] = {};
                        cfg.providers[model.provider].model = model.id;
                        writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));

                        setAgencyConfig(loadAgencyConfig());
                        setActiveModelName(`${model.provider}/${model.id}`);
                        addSystemLines([`✓ Model set to ${model.provider}/${model.id}`]);
                        setOverlayOpen("models", false);
                      });
                    });
                  });
                }}
                onClose={() => setOverlayOpen("models", false)}
              />
            ) : null}
            {overlays.skills ? (
              <SkillsPicker
                theme={theme}
                skillsRoot={process.env.AGENCY_SKILLS_ROOT || resolveSkillsRoot()}
                onSelect={(skill) => {
                  setBuffer((b) => `${skill.alias} ${b}`);
                  setOverlayOpen("skills", false);
                }}
                onClose={() => setOverlayOpen("skills", false)}
              />
            ) : null}
            {overlays.plugins ? (
              <PluginsOverlay
                theme={theme}
                skillsRoot={process.env.AGENCY_SKILLS_ROOT || resolveSkillsRoot()}
                maxVisible={maxVisiblePlugins}
                onClose={() => setOverlayOpen("plugins", false)}
              />
            ) : null}
            {overlays.review ? (
              <ReviewMenu
                theme={theme}
                onSelect={(action) => {
                  setBuffer(action.prompt);
                  setOverlayOpen("review", false);
                }}
                onClose={() => setOverlayOpen("review", false)}
              />
            ) : null}
            {overlays.status ? (
              <StatusDashboard
                theme={theme}
                providers={providerStatuses}
                skillsPath={skillsLabel}
                skillsCount={15}
                mcpServers={mcpServers}
                routingWeightsCount={hasRoutingWeights ? 1 : 0}
                sessionId={session.id}
                messageCount={session.messages.length}
                contextPercent={contextUsage.percent}
                contextTokens={contextUsage.estimatedTokens}
                contextMax={contextUsage.contextWindow}
                currentModel={displayModelName}
                agentMode={agentMode}
                lastUsage={lastUsage}
                onClose={() => setOverlayOpen("status", false)}
              />
            ) : null}
            {overlays.variant ? (
              <VariantOverlay
                theme={theme}
                modelName={variantConfig.modelName}
                providerId={variantConfig.providerId}
                modelSpec={variantConfig.modelSpec}
                variants={variantConfig.variants}
                currentThinking={variantConfig.currentThinking}
                onSelect={(value, name) => {
                  import("node:fs").then(({ readFileSync, writeFileSync, mkdirSync, existsSync: fsExists }) => {
                    import("node:os").then(({ homedir }) => {
                      import("node:path").then(({ join: pjoin }) => {
                        const dir = pjoin(homedir(), ".agency");
                        if (!fsExists(dir)) mkdirSync(dir, { recursive: true });
                        const cfgPath = pjoin(dir, "config.json");
                        let cfg: Record<string, any> = {};
                        try {
                          cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
                        } catch { /* new file */ }
                        const providerId = agencyConfig.defaultProvider;
                        if (!cfg.providers) cfg.providers = {};
                        if (!cfg.providers[providerId]) cfg.providers[providerId] = {};
                        cfg.providers[providerId].thinking = value;
                        writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));

                        setAgencyConfig(loadAgencyConfig());
                        addSystemLines([`✓ Thinking variant set to ${name} (${value === 0 ? "off" : value})`]);
                        setOverlayOpen("variant", false);
                      });
                    });
                  });
                }}
                onClose={() => setOverlayOpen("variant", false)}
              />
            ) : null}
            {overlays.route ? (
              <RouteOverlay
                theme={theme}
                lastPrompt={(() => {
                  const userMsgs = session.messages
                    .filter((m) => m.role === "user")
                    .filter((m) => !m.content.trimStart().startsWith("/") && !m.content.trimStart().startsWith("!"));
                  return userMsgs.length > 0 ? userMsgs[userMsgs.length - 1]!.content : null;
                })()}
                onSelect={(trainedPrompt, selectedIntent) => {
                  import("@agency/core").then(({ recordFeedback }) => {
                    try {
                      recordFeedback(project, trainedPrompt, selectedIntent);
                      addSystemLines([
                        `✓ Recorded feedback: linked last prompt keywords to intent "${selectedIntent}"`,
                        `  Prompt: "${trainedPrompt.slice(0, 60)}${trainedPrompt.length > 60 ? "..." : ""}"`,
                      ]);
                    } catch (err) {
                      addSystemLines([
                        `Error recording feedback: ${err instanceof Error ? err.message : String(err)}`,
                      ]);
                    }
                    setOverlayOpen("route", false);
                  });
                }}
                onClose={() => setOverlayOpen("route", false)}
              />
            ) : null}
            {overlays.resume ? (
              <SessionPicker
                theme={theme}
                sessions={sessionSummaries}
                index={resumeIndex}
                setIndex={setResumeIndex}
                deletingId={sessionDeletingId}
                setDeletingId={setSessionDeletingId}
                onSelect={(s) => {
                  const loaded = loadSession(project, s.id);
                  if (loaded) {
                    setSession(loaded);
                    setPlanTodos([]);
                    addSystemLines([`Resumed session ${s.id} (${s.messageCount} messages)`]);
                  }
                  setOverlayOpen("resume", false);
                  setPhase("main");
                }}
                onClose={() => {
                  setOverlayOpen("resume", false);
                }}
                onDelete={handleDeleteSession}
              />
            ) : null}
            {overlays.mcp ? (
              <McpOverlay
                theme={theme}
                projectRoot={project}
                onClose={() => setOverlayOpen("mcp", false)}
                onReload={() => {
                  setMcpServers(loadMcpConfigs(project));
                  setMcpConnecting(true);
                  initializeMcpServers(project).finally(() => {
                    setMcpConnecting(false);
                  });
                }}
              />
            ) : null}
            {overlays.agents ? (
              <SubagentsOverlay
                theme={theme}
                project={project}
                onClose={() => setOverlayOpen("agents", false)}
              />
            ) : null}
            {overlays.project ? (
              <WelcomeScreen
                theme={theme}
                projects={recentProjects}
                index={projectIndex}
                setIndex={setProjectIndex}
                cwd={project}
                cwdIsProject={isValidProject(project)}
                onSelect={(p) => {
                  addSystemLines([`Switched to project: ${p.name} (${p.path})`]);
                  setOverlayOpen("project", false);
                }}
                onUseCwd={() => {
                  addSystemLines([`Using current directory as project`]);
                  setOverlayOpen("project", false);
                }}
                onClose={() => setOverlayOpen("project", false)}
              />
            ) : null}
          </Box>
        ) : (
          <>
            {(() => {
              const activeScrollOffset = userHasScrolledUpRef.current
                ? scrollOffset
                : getMaxScrollOffset(virtualLinesCount, conversationHeight, survivalModeActive);
              return (
                <>
                  <MemoConversation
                    theme={theme}
                    messages={session.messages}
                    loading={loading}
                    viewportHeight={conversationHeight}
                    scrollOffset={activeScrollOffset}
                    cols={composerWidth}
                    project={project}
                    modelName={displayModelName}
                    agentMode={agentMode}
                    indexing={indexing}
                    indexReady={indexReady}
                    themeId={themeId}
                    noProvider={!providerStatuses.some((p) => p.configured)}
                    subagents={subagents}
                    expandedTui={expandedTui}
                    goalActive={goalActive}
                    focusedMessageId={focusedMessageId}
                  />
                  <ErrorBanner
                    theme={theme}
                    errors={errorNotifications}
                    onDismiss={dismissError}
                  />
                </>
              );
            })()}
            {loading && !goalActive ? (
              <ToolActivity
                theme={theme}
                active={loading}
                phase={activityPhase}
                startMs={loadStartMs}
                tokenCount={tokenCount}
                subagents={subagents}
              />
            ) : null}
            {goalActive ? (
              <GoalRunner
                theme={theme}
                task={goalTask}
                steps={goalSteps}
                currentStep={goalCurrentStep}
                totalSteps={goalSteps.length}
                startMs={goalStartMs}
                active={goalActive}
                viewMode={goalRunnerViewMode}
                maxVisibleSteps={computedMaxVisibleSteps}
                subagents={subagents}
                tokenCount={tokenCount}
              />
            ) : null}
            {planActive ? (
              <PlanPanel theme={theme} todos={planTodos} maxVisible={planMaxVisible} />
            ) : null}
            {indexing ? (
              <IndexProgressPanel
                theme={theme}
                progress={indexProgress}
                active={indexing}
              />
            ) : null}
          </>
        )}
      </Shell>
    </TerminalViewport>
  );
}
;

