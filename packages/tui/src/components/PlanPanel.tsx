import { Box, Text } from "ink";
import { memo } from "react";
import type { ThemeTokens } from "../themes/registry.js";

/** One plan item — the `{ step, status }` shape the `update_plan` tool publishes. */
export interface PlanTodo {
  step: string;
  status: string; // "pending" | "in_progress" | "completed"
}

function statusGlyph(status: string): string {
  if (status === "completed") return "✓";
  if (status === "in_progress") return "▶";
  return "□";
}

// The panel renders its own status glyph (✓/▶/□), so a model-authored emoji
// prefix on the step text ("🎨 Subagent 1: …", "✅ Final build…") is pure noise
// that reads as clutter. Strip a leading run of pictographs (with an optional
// variation selector) and the following space. Mid-text content is untouched;
// a plain title passes through unchanged.
const LEADING_EMOJI_RE = /^(?:\p{Extended_Pictographic}️?\s*)+/u;
export function cleanPlanStep(step: string): string {
  return typeof step === "string" ? step.replace(LEADING_EMOJI_RE, "").trimStart() : "";
}

function statusColor(status: string, theme: ThemeTokens): string {
  if (status === "completed") return theme.success;
  if (status === "in_progress") return theme.accent;
  return theme.muted;
}

export function selectPlanRows(
  todos: PlanTodo[],
  maxVisible?: number,
  compact = true
): { rows: Array<{ todo: PlanTodo; index: number }>; aboveCount: number; belowCount: number; truncated: boolean } {
  const total = todos.length;
  if (total === 0) return { rows: [], aboveCount: 0, belowCount: 0, truncated: false };

  const cap = Math.max(1, Math.min(maxVisible && maxVisible > 0 ? maxVisible : (compact ? 4 : total), compact ? 4 : total));
  const inProgress = todos.findIndex((t) => t.status === "in_progress");
  const firstUnfinished = todos.findIndex((t) => t.status !== "completed");
  const focus = inProgress >= 0 ? inProgress : Math.max(0, firstUnfinished);

  if (!compact) {
    const truncated = total > cap;
    const start = truncated ? Math.max(0, Math.min(focus - 1, total - cap)) : 0;
    const end = Math.min(total, start + cap);
    return {
      rows: todos.slice(start, end).map((todo, offset) => ({ todo, index: start + offset })),
      aboveCount: start,
      belowCount: total - end,
      truncated,
    };
  }

  const indices: number[] = [];
  const add = (idx: number) => {
    if (idx >= 0 && idx < total && !indices.includes(idx) && indices.length < cap) {
      indices.push(idx);
    }
  };

  for (let i = focus - 1; i >= 0; i--) {
    if (todos[i]!.status === "completed") {
      add(i);
      break;
    }
  }
  add(focus);
  for (let i = focus + 1; i < total && indices.length < cap; i++) {
    if (todos[i]!.status !== "completed") add(i);
  }
  for (let i = focus + 1; i < total && indices.length < cap; i++) add(i);

  indices.sort((a, b) => a - b);
  const first = indices[0] ?? 0;
  const last = indices[indices.length - 1] ?? -1;
  return {
    rows: indices.map((index) => ({ todo: todos[index]!, index })),
    aboveCount: first,
    belowCount: Math.max(0, total - last - 1),
    truncated: indices.length < total,
  };
}

/**
 * The live plan / todo list for the current turn, driven by the `plan:updated`
 * event the `update_plan` tool publishes. Each item's status is exactly what the
 * model set on its last `update_plan` call — real per-step progress, not a
 * decorative flip. Renders nothing when there is no active plan — including once
 * every step is completed, so a finished checklist auto-dismisses instead of
 * lingering above the composer after the turn is done.
 */
export const PlanPanel = memo(function PlanPanel({
  todos,
  theme,
  maxVisible,
  compact = true,
}: {
  todos: PlanTodo[];
  theme: ThemeTokens;
  /**
   * Cap on rendered item rows. The caller reserves the matching height in the
   * layout, so a long plan can't overflow the viewport and clip itself (the
   * panel used to render every item with no height reservation → ink clipped
   * the bottom, so a "0/6" plan showed only 3-4 rows).
   */
  maxVisible?: number;
  compact?: boolean;
}) {
  if (todos.length === 0 || todos.every((t) => t.status === "completed")) return null;
  const total = todos.length;
  const done = todos.filter((t) => t.status === "completed").length;
  const { rows, aboveCount, belowCount, truncated } = selectPlanRows(todos, maxVisible, compact);

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={theme.dimBorder}
      paddingX={1}
      marginY={0}
      width="100%"
      overflow="hidden"
    >
      <Box flexDirection="row" marginBottom={0}>
        <Text color={theme.muted} bold>
          Plan{"  "}
          <Text color={done === total ? theme.success : theme.accent} bold={false}>
            {done}/{total}
          </Text>
        </Text>
      </Box>
      {rows.map(({ todo: t, index }) => (
        <Box key={index} flexDirection="row" overflow="hidden" marginLeft={1}>
          <Text color={statusColor(t.status, theme)}>{statusGlyph(t.status)} </Text>
          <Box flexGrow={1} overflow="hidden">
            <Text
              color={t.status === "in_progress" ? theme.text : theme.muted}
              dimColor={t.status === "pending"}
              wrap="truncate-end"
            >
              {cleanPlanStep(t.step)}
            </Text>
          </Box>
        </Box>
      ))}
      {truncated ? (
        <Box marginLeft={1}>
          <Text color={theme.muted} dimColor>
            {aboveCount > 0 ? `↑ ${aboveCount} done  ` : ""}
            {belowCount > 0 ? `↓ ${belowCount} more` : ""}
          </Text>
        </Box>
      ) : null}
    </Box>
  );
});
