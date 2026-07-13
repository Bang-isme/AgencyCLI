import { memo } from "react";
import { Box, Text } from "ink";
import type { ThemeTokens } from "../themes/registry.js";
import { SPINNER_DOTS } from "../motion/design-system.js";
import { useTick } from "../motion/useTick.js";
import { getGroundedTargetName, getSemanticToolOperation, toPastTense } from "../utils/conversation/tool-labels.js";
import type { RuntimeActivity } from "../state/runtime-activity.js";
import { PresentationMapper, type CompactRowViewModel } from "../presentation/presentation-mapper.js";

export type { RuntimeActivity } from "../state/runtime-activity.js";

export interface ActivityRailProps {
  theme: ThemeTokens;
  activities: RuntimeActivity[];
  maxRows?: number;
}

function formatDuration(ms?: number): string {
  if (ms === undefined) return "";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export function formatRuntimeActivityLabel(activity: RuntimeActivity): string {
  if (activity.lifecycle?.label) return activity.lifecycle.label;
  if (activity.action === "loop") {
    return activity.name;
  }
  const target = activity.target ? getGroundedTargetName(activity.target) : "";
  const base = getSemanticToolOperation(activity.name, "", target);
  return activity.status === "active" ? base : toPastTense(base);
}

export function recentRailActivities(activities: RuntimeActivity[], maxRows: number): RuntimeActivity[] {
  const completed = activities.filter((activity) => activity.status !== "active");
  const collapsed: RuntimeActivity[] = [];
  for (const activity of completed) {
    const last = collapsed[collapsed.length - 1];
    if (
      last &&
      last.name === activity.name &&
      last.target === activity.target &&
      last.status === activity.status
    ) {
      collapsed[collapsed.length - 1] = activity;
    } else {
      collapsed.push(activity);
    }
  }
  return collapsed.slice(-maxRows);
}

export const ActivityRail = memo(function ActivityRail({
  theme,
  activities,
  maxRows = 4,
}: ActivityRailProps) {
  const active = false;
  const tick = useTick(active, 120);
  const spinner = SPINNER_DOTS[tick % SPINNER_DOTS.length] ?? ">";
  const rows = recentRailActivities(activities, maxRows);

  if (rows.length === 0) return null;

  return (
    <Box flexDirection="column" marginTop={1} paddingLeft={1}>
      <Box flexDirection="row">
        <Text color={theme.muted}>Activity</Text>
        <Text color={theme.dimBorder}> · </Text>
        <Text color={theme.muted}>{rows.length} recent</Text>
      </Box>
      {rows.map((activity) => {
        let view: CompactRowViewModel;
        if (activity.lifecycle) {
          view = PresentationMapper.mapToCompactRow(activity.lifecycle, theme, { tick });
        } else {
          const marker =
            activity.status === "active" ? spinner :
            activity.status === "failed" ? "x" :
            activity.status === "system" ? "!" :
            "✓";
          const colorKey: keyof ThemeTokens =
            activity.status === "active" ? "accent" :
            activity.status === "failed" ? "danger" :
            activity.status === "system" ? "warning" :
            "success";
          const duration = formatDuration(activity.durationMs);
          const detail = [activity.summary, duration].filter(Boolean).join(" · ");
          const label = formatRuntimeActivityLabel(activity);
          const worker = activity.agentId && activity.agentId !== "main" ? `worker.${activity.agentId}` : undefined;
          view = {
            id: activity.id,
            glyph: marker,
            glyphColor: colorKey,
            label,
            sublabel: worker,
            metaText: detail,
            status: activity.status === "active" ? "running" : activity.status === "failed" ? "failed" : "succeeded",
          };
        }

        return (
          <Box key={view.id} flexDirection="row">
            <Text color={theme[view.glyphColor]}>{view.glyph} </Text>
            <Text color={theme.text} bold={view.status === "running"} wrap="truncate">
              {view.label}
            </Text>
            {view.sublabel ? <Text color={theme.muted}> · {view.sublabel}</Text> : null}
            {view.metaText ? <Text color={theme.muted}> · {view.metaText}</Text> : null}
          </Box>
        );
      })}
    </Box>
  );
});
