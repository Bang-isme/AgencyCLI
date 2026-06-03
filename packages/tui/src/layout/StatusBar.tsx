import { memo } from "react";
import { Box, Text } from "ink";
import type { ThemeTokens } from "../themes/registry.js";
import { useTerminalLayout } from "./TerminalLayoutProvider.js";
import type { AgentMode } from "../state/agent-modes.js";
import type { DisclosureLevel } from "../state/DisclosureProvider.js";

export interface WorkerHeartbeat {
  name: string;
  status: "active" | "idle" | "done";
}

export interface StatusBarProps {
  theme: ThemeTokens;
  sessionId: string;
  themeId: string;
  hint?: string;
  loading?: boolean;
  contextPercent?: number;
  modelName?: string;
  budgetMode?: string;
  hasRoutingWeights?: boolean;
  thinkingLabel?: string;
  /** Current mode label (e.g. "Agent", "Plan") */
  modeLabel?: string;
  /** Current phase label (e.g. "Validating", "Indexing") */
  phaseLabel?: string;
  /** Active worker heartbeats for center zone */
  workers?: WorkerHeartbeat[];
  /** Token/context usage display string (e.g. "4.2K") */
  contextTokens?: string;
  /** Description of the currently active agent mode */
  modeDescription?: string;
  /** Active interaction mode */
  agentMode?: AgentMode;
  /** Progressive-disclosure level (Ctrl+D). Shown only when above "default". */
  disclosureLevel?: DisclosureLevel;
}

export function getModeColor(mode: AgentMode | undefined, theme: ThemeTokens): string {
  if (!mode) return theme.success;
  switch (mode) {
    case "agent":
      return theme.accent;    // Blue
    case "plan":
      return theme.warning;   // Amber
    case "debug":
      return theme.danger;    // Red
    case "ask":
      return theme.success;   // Green
    default:
      return theme.success;
  }
}

interface CenterZoneProps {
  workers: WorkerHeartbeat[];
  hint?: string;
  modeDescription?: string;
  theme: ThemeTokens;
}

const CenterZone = memo(function CenterZone({
  workers,
  hint,
  modeDescription,
  theme,
}: CenterZoneProps) {
  const activeWorkers = workers.filter((w) => w.status === "active");

  let centerText = "";
  if (activeWorkers.length === 1) {
    centerText = `Active: ${activeWorkers[0].name}`;
  } else if (activeWorkers.length > 1) {
    centerText = `Running ${activeWorkers.length} active workers`;
  } else {
    centerText = hint ?? modeDescription ?? "";
  }

  return (
    <Text color={theme.muted} wrap="truncate">
      {centerText}
    </Text>
  );
});

export const StatusBar = memo(function StatusBar({
  theme,
  hint,
  loading = false,
  contextPercent = 0,
  modelName,
  budgetMode,
  hasRoutingWeights = false,
  thinkingLabel,
  modeLabel: modeLabelProp,
  phaseLabel,
  workers = [],
  contextTokens,
  modeDescription,
  agentMode,
  disclosureLevel = "default",
}: StatusBarProps) {
  const { composerWidth } = useTerminalLayout();

  // ---------- LEFT ZONE: Mode & Phase ----------
  const modeText = modeLabelProp ?? (loading ? "Routing" : "Idle");
  const indicatorSymbol = loading ? "→" : "●";
  const leftIndicator = `${indicatorSymbol} ${modeText}${phaseLabel ? ` · ${phaseLabel}` : ""}`;

  // ---------- RIGHT ZONE: Model & Context Stats ----------
  const ctxColor =
    contextPercent > 80
      ? theme.danger
      : contextPercent > 50
        ? theme.warning
        : theme.success;
  const clampedPercent = Math.max(0, Math.min(100, contextPercent));

  const modelLabel = modelName
    ? composerWidth < 60
      ? modelName.slice(-8)
      : composerWidth < 70
        ? modelName.slice(-12)
        : modelName.length > 20
          ? modelName.slice(-20)
          : modelName
    : "";

  const tokenDisplay = contextTokens ?? `${clampedPercent}%`;

  // Responsive: collapse zones for narrow terminals
  const showCenter = composerWidth >= 50;
  const showRightExtended = composerWidth >= 65;

  return (
    <Box
      flexDirection="row"
      justifyContent="space-between"
      width={composerWidth}
      overflow="hidden"
    >
      {/* LEFT ZONE — Mode & Phase */}
      <Box flexShrink={0} overflow="hidden">
        <Text color={getModeColor(agentMode, theme)} bold wrap="truncate">
          {"  "}{leftIndicator}
        </Text>
      </Box>

      {/* CENTER ZONE — Worker Heartbeats */}
      {showCenter ? (
        <Box flexGrow={1} justifyContent="center" overflow="hidden">
          <CenterZone
            workers={workers}
            hint={hint}
            modeDescription={modeDescription}
            theme={theme}
          />
        </Box>
      ) : null}

      {/* RIGHT ZONE — Model & Context Stats */}
      <Box flexShrink={0} overflow="hidden">
        <Box flexDirection="row">
          {showRightExtended && modelLabel ? (
            <>
              <Text color={theme.muted} wrap="truncate">
                {modelLabel}
              </Text>
              <Text color={theme.dimBorder}> · </Text>
            </>
          ) : null}
          <Text color={ctxColor} bold>
            {tokenDisplay}
          </Text>
          {showRightExtended && hasRoutingWeights ? (
            <>
              <Text color={theme.dimBorder}> · </Text>
              <Text color={theme.accent}>weights</Text>
            </>
          ) : null}
          {showRightExtended && budgetMode ? (
            <>
              <Text color={theme.dimBorder}> · </Text>
              <Text color={theme.muted}>{budgetMode}</Text>
            </>
          ) : null}
          {thinkingLabel && showRightExtended ? (
            <>
              <Text color={theme.dimBorder}> · </Text>
              {thinkingLabel === "off" ? (
                <Text color={theme.muted}>
                  thinking: off
                </Text>
              ) : (
                <Text color={theme.warning} bold>
                  thinking: {thinkingLabel}
                </Text>
              )}
            </>
          ) : null}
          {disclosureLevel !== "default" && showRightExtended ? (
            <>
              <Text color={theme.dimBorder}> · </Text>
              <Text color={theme.accent}>detail: {disclosureLevel}</Text>
            </>
          ) : null}
          <Text color={theme.muted}>{"  "}</Text>
        </Box>
      </Box>
    </Box>
  );
});
