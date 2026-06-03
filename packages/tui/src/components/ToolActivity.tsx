import { memo, useEffect, useState } from "react";
import { Box, Text } from "ink";
import type { ThemeTokens } from "../themes/registry.js";
import { useTick } from "../motion/useTick.js";
import { getPhaseLabel, type ActivityPhase } from "../state/context-tracker.js";
import { pulseDots, SPINNER_BLOCKS } from "../motion/design-system.js";
import { formatTokenCount } from "../utils/text.js";
import { normalizeWorkerName, formatElapsed } from "@agency/core";
import type { SubagentStatus } from "./SubagentPanel.js";

export interface ToolActivityProps {
  theme: ThemeTokens;
  active?: boolean;
  phase?: ActivityPhase;
  startMs?: number;
  tokenCount?: number;
  subagents?: SubagentStatus[];
}

interface ShimmerRun {
  text: string;
  color: string;
}

/**
 * Builds grouped text runs for a soft light band sweeping left→right across the
 * label. The base color stays steady (no global dim), so only a localized
 * highlight travels — a calm shimmer with zero on/off flicker.
 */
function buildShimmerRuns(label: string, tick: number, theme: ThemeTokens): ShimmerRun[] {
  const chars = [...label];
  const len = chars.length;
  if (len === 0) return [];

  const GAP = 12; // dark pause between sweeps
  const BAND = 2; // half-width of the bright band
  const SPEED = 2; // cells advanced per tick
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
}: ToolActivityProps) {
  const tick = useTick(active, 100);
  const wave = SPINNER_BLOCKS[tick % SPINNER_BLOCKS.length]!;

  let displayLabel = getPhaseLabel(phase);

  const runningSubagent = subagents?.find(a => a.status === "running");
  if (runningSubagent) {
    const rawName = normalizeWorkerName(runningSubagent.agentId);
    // Ensure clean prefix and prevent duplicate worker.worker.
    const name = rawName.startsWith("worker.") ? rawName : `worker.${rawName}`;
    
    // Prioritize active step label, fallback to phase/task
    const activeStep = runningSubagent.steps?.find(s => s.status === "active");
    let progressText = activeStep?.label || runningSubagent.phase || runningSubagent.task || "processing";
    if (progressText.length > 50) {
      progressText = progressText.slice(0, 47) + "...";
    }

    // Derive the running worker's elapsed from its spawn anchor so it advances
    // on this component's own 200ms timer (below) — smooth, and independent of
    // how often the parent re-flushes the subagents array.
    const subElapsedMs = runningSubagent.spawnTs !== undefined
      ? Date.now() - runningSubagent.spawnTs
      : runningSubagent.elapsedMs;
    const subagentElapsed = subElapsedMs !== undefined ? ` · ${formatElapsed(subElapsedMs)}` : "";
    displayLabel = `${name} ➔ ${progressText}${subagentElapsed}`;
  }

  const dots = pulseDots(tick);

  const [elapsed, setElapsed] = useState(() => (startMs > 0 ? Date.now() - startMs : 0));

  useEffect(() => {
    if (!active || startMs === 0) return;
    const interval = setInterval(() => {
      setElapsed(Date.now() - startMs);
    }, 200); // 5Hz ticks locally is optimal
    return () => clearInterval(interval);
  }, [active, startMs]);

  if (!active) return null;

  // Holographic light sweep: a soft band glides left→right across the label
  // (same beam identity as the logo). No global dim/brighten — the base stays
  // steady, only a localized highlight travels, so there is zero on/off flicker.
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
        {" "}· esc cancel
      </Text>
    </Box>
  );
});
