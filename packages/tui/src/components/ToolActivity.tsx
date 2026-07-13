import { memo, useEffect, useState } from "react";
import { Box, Text } from "ink";
import type { ActionLifecycleEvent } from "@agency/core";
import type { ThemeTokens } from "../themes/registry.js";
import { useTick } from "../motion/useTick.js";
import { getPhaseLabel, type ActivityPhase } from "../state/context-tracker.js";
import { pulseDots, SPINNER_BLOCKS } from "../motion/design-system.js";
import { formatTokenCount } from "../utils/text.js";
import { normalizeWorkerName, formatElapsed } from "@agency/core";
import type { SubagentStatus } from "../state/subagent-status.js";
import { PresentationMapper } from "../presentation/presentation-mapper.js";

export interface ToolActivityProps {
  theme: ThemeTokens;
  active?: boolean;
  phase?: ActivityPhase;
  startMs?: number;
  tokenCount?: number;
  subagents?: SubagentStatus[];
  label?: string;
  lifecycle?: ActionLifecycleEvent;
}

interface ShimmerRun {
  text: string;
  color: string;
}

function buildShimmerRuns(label: string, tick: number, theme: ThemeTokens): ShimmerRun[] {
  const chars = [...label];
  const len = chars.length;
  if (len === 0) return [];

  const GAP = 12;
  const BAND = 2;
  const SPEED = 2;
  const head = len > 1 ? Math.floor(tick * SPEED) % (len + GAP) : -99;

  const runs: ShimmerRun[] = [];
  for (let i = 0; i < len; i++) {
    const d = Math.abs(i - head);
    let color = theme.text;
    if (d === 0) color = theme.highlight;
    else if (d <= BAND) color = theme.accent;

    const last = runs[runs.length - 1];
    if (last && last.color === color) last.text += chars[i];
    else runs.push({ text: chars[i]!, color });
  }
  return runs;
}

export const ToolActivity = memo(function ToolActivity({
  theme,
  active = true,
  phase = "routing",
  startMs = 0,
  tokenCount = 0,
  subagents,
  label,
  lifecycle,
}: ToolActivityProps) {
  const tick = useTick(active, 100);
  const wave = SPINNER_BLOCKS[tick % SPINNER_BLOCKS.length]!;

  let displayLabel = label;
  if (!displayLabel && lifecycle) {
    displayLabel = PresentationMapper.mapToCompactRow(lifecycle, theme, { tick }).label;
  }
  if (!displayLabel) {
    displayLabel = getPhaseLabel(phase);
  }

  const runningSubagent = subagents?.find(a => a.status === "running");
  if (runningSubagent && !label && !lifecycle) {
    const rawName = normalizeWorkerName(runningSubagent.agentId);
    const name = rawName.startsWith("worker.") ? rawName : `worker.${rawName}`;
    const activeStep = runningSubagent.steps?.find(s => s.status === "active");
    let progressText = activeStep?.label || runningSubagent.phase || runningSubagent.task || "processing";
    if (progressText.length > 50) {
      progressText = progressText.slice(0, 47) + "...";
    }
    displayLabel = `${name} ➔ ${progressText}`;
  }

  const dots = pulseDots(tick);
  const [elapsed, setElapsed] = useState(() => (startMs > 0 ? Date.now() - startMs : 0));

  useEffect(() => {
    if (!active || startMs === 0) return;
    const interval = setInterval(() => {
      setElapsed(Date.now() - startMs);
    }, 200);
    return () => clearInterval(interval);
  }, [active, startMs]);

  if (!active) return null;

  const labelRuns = buildShimmerRuns(displayLabel, tick, theme);

  return (
    <Box flexDirection="row" marginTop={1} marginBottom={0} paddingLeft={1}>
      <Text color={theme.accent}>{wave} </Text>
      {labelRuns.map((run, i) => (
        <Text key={i} color={run.color} bold>{run.text}</Text>
      ))}
      <Text color={theme.accent}>{dots} </Text>
      <Text color={theme.muted}>
        · {formatElapsed(elapsed)}
        {tokenCount > 0 ? ` · ${formatTokenCount(tokenCount)} tokens` : ""}
      </Text>
    </Box>
  );
});
