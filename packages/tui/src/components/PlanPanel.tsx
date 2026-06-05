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
}) {
  if (todos.length === 0 || todos.every((t) => t.status === "completed")) return null;
  const total = todos.length;
  const done = todos.filter((t) => t.status === "completed").length;

  // Window the list when it exceeds the budget, anchored so the active (or
  // first unfinished) step stays visible — completed steps scroll off the top.
  const cap = maxVisible && maxVisible > 0 ? maxVisible : total;
  const truncated = total > cap;
  let start = 0;
  if (truncated) {
    const inProgress = todos.findIndex((t) => t.status === "in_progress");
    const focus = inProgress >= 0 ? inProgress : Math.max(0, todos.findIndex((t) => t.status !== "completed"));
    start = Math.max(0, Math.min(focus - 1, total - cap));
  }
  const end = Math.min(total, start + cap);
  const aboveCount = start;
  const belowCount = total - end;

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
      <Text color={theme.muted}>
        Plan{"  "}
        <Text color={done === total ? theme.success : theme.accent}>
          {done}/{total}
        </Text>
      </Text>
      {todos.slice(start, end).map((t, i) => (
        <Box key={start + i} flexDirection="row" overflow="hidden">
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
        <Text color={theme.muted} dimColor>
          {aboveCount > 0 ? `↑ ${aboveCount} done  ` : ""}
          {belowCount > 0 ? `↓ ${belowCount} more` : ""}
        </Text>
      ) : null}
    </Box>
  );
});
