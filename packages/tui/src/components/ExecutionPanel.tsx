import { memo } from "react";
import { Box, Text } from "ink";
import type { ThemeTokens } from "../themes/registry.js";
import { useDisclosure } from "../state/DisclosureProvider.js";
import { LIFECYCLE_GLYPHS, SEVERITY_GLYPHS } from "../motion/design-system.js";
import {
  thoughtSeverityColor as severityColor,
  thoughtSeverityIcon as severityIcon,
} from "../utils/severity.js";
import type { RuntimeThoughtEvent } from "@agency/core";

export interface ExecutionPanelProps {
  theme: ThemeTokens;
  thoughts: RuntimeThoughtEvent[];
  width: number;
  /** Active execution phase */
  phase: string;
  /** Provider info for context badge */
  providerLabel?: string;
}

type PhaseStatus = "pending" | "active" | "done";
export interface ExecutionPhaseStatuses {
  plan: PhaseStatus;
  execute: PhaseStatus;
  verify: PhaseStatus;
  recover: PhaseStatus | "hidden";
  complete: PhaseStatus;
}

/**
 * §8.10-B — map the coarse activity phase to the status of each lifecycle node.
 * Extracted as a pure function so the mapping is unit-tested directly, and
 * extended to cover the realtime per-tool phases now driven from runtime
 * thoughts (editing/running → EXECUTE active, analyzing → VERIFY active, …),
 * not just the original routing/writing/idle.
 */
export function computeExecutionPhaseStatuses(phase: string): ExecutionPhaseStatuses {
  const s: ExecutionPhaseStatuses = {
    plan: "pending", execute: "pending", verify: "pending", recover: "hidden", complete: "pending",
  };
  const p = phase.toLowerCase();
  if (["routing", "reading", "exploring", "thinking"].includes(p)) {
    s.plan = "active";
  } else if (["writing", "editing", "running"].includes(p)) {
    s.plan = "done";
    s.execute = "active";
  } else if (["validating", "analyzing"].includes(p)) {
    s.plan = "done";
    s.execute = "done";
    s.verify = "active";
  } else if (p === "recovering" || p === "rolling_back") {
    s.plan = "done";
    s.execute = "done";
    s.verify = "done";
    s.recover = "active";
  } else if (p === "idle") {
    s.plan = "done";
    s.execute = "done";
    s.verify = "done";
    s.complete = "done";
  }
  return s;
}

/**
 * Unified Execution Panel.
 *
 * Shows operational execution state — what the system is DOING, not what it's THINKING.
 * Collapsible by disclosure level (Ctrl+D).
 */
export const ExecutionPanel = memo(function ExecutionPanel({
  theme,
  thoughts,
  width,
  phase,
  providerLabel,
}: ExecutionPanelProps) {
  const { level } = useDisclosure();

  if (level === "default" && phase === "idle" && thoughts.length === 0) return null;

  const displayThoughts = level === "expert"
    ? thoughts
    : level === "advanced"
      ? thoughts.slice(-3)
      : [];

  const counts = {
    info: thoughts.filter((t) => t.severity === "info").length,
    adaptation: thoughts.filter((t) => t.severity === "adaptation").length,
    warning: thoughts.filter((t) => t.severity === "warning").length,
    critical: thoughts.filter((t) => t.severity === "critical").length,
  };

  const hasCritical = counts.critical > 0;
  const innerWidth = width - 4;

  // Map phase to the status of each visual lifecycle node (pure + tested).
  const { plan: planStatus, execute: executeStatus, verify: verifyStatus, recover: recoverStatus, complete: completeStatus } =
    computeExecutionPhaseStatuses(phase);

  // §8.10-D — the sub-line under the ACTIVE node is the agent's REAL latest
  // activity (the most recent runtime thought), not a hardcoded decorative
  // string ("inspect routing" / "apply patches" / "compile application") that
  // had no relation to what was actually running. Empty when there is no live
  // narration (e.g. cognitionStream off) → the node shows no fake sub-line.
  const currentActivity = thoughts.length > 0 ? [thoughts[thoughts.length - 1]!.message] : [];

  const renderPhaseNode = (
    label: string,
    status: "pending" | "active" | "done",
    subtasks: string[]
  ) => {
    let color = theme.muted;
    let symbol: string = LIFECYCLE_GLYPHS.pending;
    if (status === "done") {
      color = theme.success;
      symbol = LIFECYCLE_GLYPHS.done;
    } else if (status === "active") {
      color = theme.highlight;
      symbol = LIFECYCLE_GLYPHS.active;
    }

    const sublines: React.ReactNode[] = [];
    if (status === "active" && subtasks.length > 0) {
      subtasks.forEach((task, idx) => {
        const isLastSub = idx === subtasks.length - 1;
        const connector = isLastSub ? " └─ " : " ├─ ";
        sublines.push(
          <Box key={idx} flexDirection="row" marginLeft={1}>
            <Text color={theme.muted}>{connector}</Text>
            <Text color={theme.text} dimColor>{task}</Text>
          </Box>
        );
      });
    }

    return (
      <Box flexDirection="column" key={label} marginTop={0}>
        <Box flexDirection="row">
          <Text color={color} bold={status === "active"}>
            {symbol} {label}
          </Text>
        </Box>
        {sublines}
      </Box>
    );
  };

  return (
    <Box
      flexDirection="column"
      borderStyle="single"
      borderColor={hasCritical ? theme.danger : theme.dimBorder}
      paddingX={1}
      width={width}
      marginBottom={0}
      marginTop={0}
      overflow="hidden"
    >
      {/* Header Line */}
      <Box flexDirection="row" justifyContent="space-between" width={innerWidth}>
        <Box flexDirection="row">
          <Text color={theme.text} bold>
            {phase !== "idle" ? `● ACTIVE: ${phase.toUpperCase()}` : "● STANDBY"}
          </Text>
          {providerLabel ? (
            <Text color={theme.muted}>
              {"  "}{providerLabel}
            </Text>
          ) : null}
        </Box>
        {level === "default" && thoughts.length > 0 ? (
          <Text color={theme.muted} dimColor>
            {thoughts.length} events · ctrl+d
          </Text>
        ) : null}
        {level !== "default" ? (
          <Text color={theme.muted} dimColor>
            {thoughts.length} events
            {counts.adaptation > 0 ? ` · ${counts.adaptation}a` : ""}
            {counts.warning > 0 ? ` · ${counts.warning}w` : ""}
            {counts.critical > 0 ? ` · ${counts.critical}${SEVERITY_GLYPHS.critical}` : ""}
          </Text>
        ) : null}
      </Box>

      {/* Execution Orchestration Tree */}
      <Box flexDirection="column" marginTop={1} marginBottom={1} width={innerWidth}>
        {renderPhaseNode("PLAN", planStatus, currentActivity)}
        {renderPhaseNode("EXECUTE", executeStatus, currentActivity)}
        {renderPhaseNode("VERIFY", verifyStatus, currentActivity)}
        {recoverStatus !== "hidden" ? renderPhaseNode("RECOVER", recoverStatus, currentActivity) : null}
        {renderPhaseNode("COMPLETE", completeStatus, [])}
      </Box>

      {/* Operational events (advanced/expert) */}
      {displayThoughts.length > 0 ? (
        <Box flexDirection="column" marginTop={0} width={innerWidth} overflow="hidden">
          <Text color={theme.dimBorder}>{"─".repeat(innerWidth)}</Text>
          {displayThoughts.map((t) => {
            const color = severityColor(theme, t.severity);
            const icon = severityIcon(t.severity);
            return (
              <Box key={t.id} flexDirection="row" overflow="hidden" width={innerWidth}>
                <Text color={color}>
                  {icon}{" "}
                </Text>
                <Text color={theme.muted} dimColor>
                  [{t.source}]{' '}
                </Text>
                <Text wrap="wrap" color={color === theme.muted ? theme.text : color}>
                  {t.message}
                </Text>
              </Box>
            );
          })}
        </Box>
      ) : null}
    </Box>
  );
});
