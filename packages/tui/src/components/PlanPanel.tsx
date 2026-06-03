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

function statusColor(status: string, theme: ThemeTokens): string {
  if (status === "completed") return theme.success;
  if (status === "in_progress") return theme.accent;
  return theme.muted;
}

/**
 * The live plan / todo list for the current turn, driven by the `plan:updated`
 * event the `update_plan` tool publishes. Each item's status is exactly what the
 * model set on its last `update_plan` call — real per-step progress, not a
 * decorative flip. Renders nothing when there is no active plan.
 */
export const PlanPanel = memo(function PlanPanel({
  todos,
  theme,
}: {
  todos: PlanTodo[];
  theme: ThemeTokens;
}) {
  if (todos.length === 0) return null;
  const done = todos.filter((t) => t.status === "completed").length;

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
        <Text color={done === todos.length ? theme.success : theme.accent}>
          {done}/{todos.length}
        </Text>
      </Text>
      {todos.map((t, i) => (
        <Box key={i} flexDirection="row" overflow="hidden">
          <Text color={statusColor(t.status, theme)}>{statusGlyph(t.status)} </Text>
          <Box flexGrow={1} overflow="hidden">
            <Text
              color={t.status === "in_progress" ? theme.text : theme.muted}
              dimColor={t.status === "pending"}
              wrap="truncate-end"
            >
              {t.step}
            </Text>
          </Box>
        </Box>
      ))}
    </Box>
  );
});
