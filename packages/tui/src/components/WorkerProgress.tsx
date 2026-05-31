import { memo } from "react";
import { Box, Text } from "ink";
import type { ThemeTokens } from "../themes/registry.js";
import { useTick } from "../motion/useTick.js";
import { SPINNER_DOTS, LIFECYCLE_GLYPHS } from "../motion/design-system.js";
import { formatTechnicalSubLine } from "./conversation/SubagentStepRow.js";

export type StepStatus = "done" | "active" | "pending";

export interface WorkerStep {
  label: string;
  status: StepStatus;
}

export interface WorkerProgressProps {
  theme: ThemeTokens;
  steps: WorkerStep[];
}



function stepColor(status: StepStatus): keyof ThemeTokens {
  switch (status) {
    case "done":
      return "success";
    case "active":
      return "accent";
    case "pending":
      return "muted";
  }
}

/**
 * Premium technical styled checklist progress for worker sub-tasks.
 * - Shows nice branch tree connectors (├─ / └─)
 * - ◆ completed steps in green (Agency lifecycle "done" marker)
 * - the signature arc spinner for the active step, in accent color
 * - ◇ pending steps in muted grey (lifecycle "pending" marker)
 * - Highlights statistics (times, tokens) and green file paths/commands
 */
export const WorkerProgress = memo(function WorkerProgress({
  theme,
  steps,
}: WorkerProgressProps) {
  const hasActive = steps.some((step) => step.status === "active");
  const tick = useTick(hasActive, 100);
  const spinner = SPINNER_DOTS[tick % SPINNER_DOTS.length]!;

  return (
    <Box flexDirection="column" marginLeft={1}>
      {steps.map((step, i) => {
        const isRunning = step.status === "active";
        const colorKey = stepColor(step.status);
        
        const isLast = i === steps.length - 1;
        const connector = isLast ? "└─ " : "├─ ";
        
        const statusLabel =
          step.status === "done"
            ? `${LIFECYCLE_GLYPHS.done} `
            : isRunning
              ? `${spinner} `
              : `${LIFECYCLE_GLYPHS.pending} `;

        return (
          <Box key={i} flexDirection="row" marginBottom={0}>
            <Text color={theme.muted}>
              {connector}
            </Text>
            <Text color={theme[colorKey]} bold={isRunning}>
              {statusLabel}
            </Text>
            <Box flexGrow={1} overflow="hidden">
              {formatTechnicalSubLine(step.label, theme)}
            </Box>
          </Box>
        );
      })}
    </Box>
  );
});
