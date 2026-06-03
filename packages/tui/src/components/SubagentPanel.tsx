import { memo, useEffect, useState } from "react";
import { Box, Text } from "ink";
import type { ThemeTokens } from "../themes/registry.js";
import { SpinnerText } from "./AnimatedText.js";
import { WorkerProgress, type WorkerStep } from "./WorkerProgress.js";
import { useDisclosure } from "../state/DisclosureProvider.js";
import { normalizeWorkerName as workerName, formatElapsed } from "@agency/core";
import { useTick } from "../motion/useTick.js";
import { SPINNER_DOTS, LIFECYCLE_GLYPHS } from "../motion/design-system.js";


export interface SubagentStatus {
  agentId: string;
  task: string;
  status: "queued" | "running" | "done" | "error";
  elapsedMs?: number;
  /**
   * Wall-clock spawn timestamp (ms). Lets the elapsed readout self-tick from a
   * stable anchor instead of the parent re-flushing the whole subagents array
   * (a full App re-render) once a second just to bump the counter.
   */
  spawnTs?: number;
  result?: string;
  /** Worker-style progress steps (if available) */
  steps?: WorkerStep[];
  /** Current execution phase label */
  phase?: string;
  thought?: string;
  text?: string;
}

export interface SubagentPanelProps {
  theme: ThemeTokens;
  agents: SubagentStatus[];
  active: boolean;
}



const STATUS_ICON: Record<SubagentStatus["status"], string> = {
  queued: LIFECYCLE_GLYPHS.pending,
  running: LIFECYCLE_GLYPHS.active, // overridden by the spinner while active
  done: LIFECYCLE_GLYPHS.done,
  error: LIFECYCLE_GLYPHS.error,
};


/**
 * Worker-style subagent panel.
 *
 * Subagents feel like runtime workers / execution units — NOT AI personalities.
 * Each worker exposes: state, phase, progress, runtime health.
 *
 * Collapsed by default in "default" disclosure level — shows only summary.
 * Expanded in "advanced"/"expert" to show per-worker steps.
 */
/**
 * Self-ticking elapsed readout. Anchors to the worker's spawn timestamp and
 * advances on its own low-frequency timer (500ms), so the parent never has to
 * re-flush the whole subagents array (and re-render the App) just to bump a
 * second counter. Drifts only with raw loop lag, never with the animation
 * frame clock — so it stays live even while the UI is under streaming load.
 */
const LiveElapsed = memo(function LiveElapsed({
  spawnTs,
  fallbackMs,
  running,
  theme,
}: {
  spawnTs?: number;
  fallbackMs?: number;
  running: boolean;
  theme: ThemeTokens;
}) {
  const [elapsed, setElapsed] = useState(() =>
    spawnTs !== undefined ? Date.now() - spawnTs : fallbackMs ?? 0
  );

  useEffect(() => {
    if (!running || spawnTs === undefined) return;
    setElapsed(Date.now() - spawnTs);
    const id = setInterval(() => setElapsed(Date.now() - spawnTs), 500);
    return () => clearInterval(id);
  }, [running, spawnTs]);

  // Once finished, freeze at the worker's final reported value.
  const value = running && spawnTs !== undefined ? elapsed : fallbackMs ?? elapsed;
  return (
    <Text color={theme.muted} dimColor>
      {formatElapsed(value)}
    </Text>
  );
});

interface WorkerRowProps {
  agent: SubagentStatus;
  theme: ThemeTokens;
  showDetails: boolean;
  isLast: boolean;
  treeConnector: string;
}

const WorkerRow = memo(function WorkerRow({
  agent,
  theme,
  showDetails,
  isLast,
  treeConnector,
}: WorkerRowProps) {
  const name = workerName(agent.agentId);
  const isActive = agent.status === "running";
  const hasDetails = (showDetails || isActive) && !!agent.steps;
  
  const tick = useTick(isActive, 100);
  const spinner = SPINNER_DOTS[tick % SPINNER_DOTS.length]!;

  let statusLabel = STATUS_ICON[agent.status];
  if (isActive) {
    statusLabel = spinner;
  }

  return (
    <Box flexDirection="column">
      {/* Worker status row */}
      <Box flexDirection="row" marginTop={0}>
        <Text color={theme.muted}>{treeConnector}</Text>
        <Box width={2}>
          <Text
            color={
              agent.status === "done"
                ? theme.success
                : agent.status === "error"
                  ? theme.danger
                  : isActive
                    ? theme.accent
                    : theme.muted
            }
          >
            {statusLabel}
          </Text>
        </Box>

        <Box width={28} marginLeft={1}>
          <Text
            color={isActive ? theme.accent : theme.text}
            bold={isActive}
            wrap="truncate"
          >
            {name}
          </Text>
        </Box>
        <Box flexGrow={1}>
          {isActive ? (
            <SpinnerText
              label={agent.phase ?? agent.task.slice(0, 40)}
              theme={theme}
            />
          ) : agent.status === "error" ? (
            <Text color={theme.danger}>
              {agent.result ?? agent.task.slice(0, 40)}
            </Text>
          ) : (
            <Text color={theme.muted} dimColor wrap="truncate">
              {agent.result ?? agent.task.slice(0, 50)}
            </Text>
          )}
        </Box>
        {agent.elapsedMs !== undefined || agent.spawnTs !== undefined ? (
          <Box marginLeft={1}>
            <LiveElapsed
              spawnTs={agent.spawnTs}
              fallbackMs={agent.elapsedMs}
              running={isActive}
              theme={theme}
            />
          </Box>
        ) : null}
      </Box>

      {/* Expanded: progress steps */}
      {hasDetails && agent.steps && agent.steps.length > 0 ? (
        <Box marginLeft={1}>
          <Box flexDirection="row">
            <Text color={theme.muted}>{isLast ? "   " : "│  "}</Text>
            <WorkerProgress theme={theme} steps={agent.steps} />
          </Box>
        </Box>
      ) : null}

    </Box>
  );
});

export const SubagentPanel = memo(function SubagentPanel({
  theme,
  agents,
  active,
}: SubagentPanelProps) {
  const { level } = useDisclosure();

  const doneCount = agents.filter((a) => a.status === "done").length;
  const errCount = agents.filter((a) => a.status === "error").length;
  const runCount = agents.filter((a) => a.status === "running").length;
  const queuedCount = agents.filter((a) => a.status === "queued").length;

  // In default mode: collapse to summary + active workers only
  const showDetails = level !== "default";
  const visibleAgents = showDetails
    ? agents
    : agents.filter((a) => a.status === "running" || a.status === "error");

  return (
    <Box
      flexDirection="column"
      borderStyle="single"
      borderColor={errCount > 0 ? theme.warning : theme.dimBorder}
      paddingX={1}
      marginBottom={0}
    >
      {/* Header — operational summary */}
      <Box flexDirection="row" justifyContent="space-between">
        <Box flexDirection="row">
          <Text color={theme.text} bold>
            Workers
          </Text>
          <Text color={theme.muted}>
            {"  "}{runCount} active
            {doneCount > 0 ? ` · ${doneCount} done` : ""}
            {queuedCount > 0 ? ` · ${queuedCount} queued` : ""}
            {errCount > 0 ? ` · ${errCount} failed` : ""}
          </Text>
        </Box>
        {!showDetails && agents.length > visibleAgents.length ? (
          <Text color={theme.muted} dimColor>
            ctrl+d expand
          </Text>
        ) : null}
      </Box>

      {/* Worker rows */}
      {visibleAgents.map((agent, idx) => {
        const isLast = idx === visibleAgents.length - 1;
        const treeConnector = isLast ? "└─ " : "├─ ";

        return (
          <WorkerRow
            key={agent.agentId}
            agent={agent}
            theme={theme}
            showDetails={showDetails}
            isLast={isLast}
            treeConnector={treeConnector}
          />
        );
      })}

      {/* Footer — interruptibility hint */}
      {active ? (
        <Box marginTop={0}>
          <Text color={theme.muted} dimColor>
            esc pause · ctrl+c safe stop
          </Text>
        </Box>
      ) : null}
    </Box>
  );
});
