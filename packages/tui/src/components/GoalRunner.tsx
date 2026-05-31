import { memo, useEffect, useState } from "react";
import { Box, Text } from "ink";
import type { ThemeTokens } from "../themes/registry.js";
import { SpinnerText } from "./AnimatedText.js";
import { useTick } from "../motion/useTick.js";
import { formatElapsed } from "@agency/core";
import {
  energyBar,
  accentDivider,
  SPINNER_DOTS,
  LIFECYCLE_GLYPHS,
} from "../motion/design-system.js";
import { formatTechnicalSubLine } from "./conversation/SubagentStepRow.js";

export interface GoalTodo {
  id: string;
  title: string;
  status: "pending" | "running" | "done" | "error";
}

export interface GoalStep {
  id: number;
  title: string;
  status: "pending" | "running" | "done" | "error";
  todos?: GoalTodo[];
  toolcallsCount?: number;
  durationMs?: number;
  progressStatus?: string;
}

export interface GoalRunnerProps {
  theme: ThemeTokens;
  task: string;
  steps: GoalStep[];
  currentStep: number;
  totalSteps: number;
  startMs: number; // Localized timer starts from startMs
  active: boolean;
  viewMode?: "flat" | "boxy";
  maxVisibleSteps?: number;
  subagents?: any[];
  tokenCount?: number;
}



const STATUS_ICON: Record<GoalStep["status"], string> = {
  pending: LIFECYCLE_GLYPHS.pending,
  running: LIFECYCLE_GLYPHS.active, // overridden by the spinner while running
  done: LIFECYCLE_GLYPHS.done,
  error: LIFECYCLE_GLYPHS.error,
};

const STATUS_COLOR_KEY: Record<GoalStep["status"], keyof ThemeTokens> = {
  pending: "muted",
  running: "accent",
  done: "success",
  error: "warning",
};

interface StepStatusIconProps {
  status: GoalStep["status"];
  active: boolean;
  theme: ThemeTokens;
}

export const StepStatusIcon = memo(function StepStatusIcon({
  status,
  active,
  theme,
}: StepStatusIconProps) {
  const isRunning = status === "running";
  const tick = useTick(active && isRunning, 100);
  const colorKey = STATUS_COLOR_KEY[status];
  const label = isRunning ? SPINNER_DOTS[tick % SPINNER_DOTS.length]! : STATUS_ICON[status];

  return (
    <Text color={theme[colorKey] as string} bold={isRunning}>
      {label}{" "}
    </Text>
  );
});

interface TodoStatusIconProps {
  status: GoalTodo["status"];
  active: boolean;
  theme: ThemeTokens;
}

export const TodoStatusIcon = memo(function TodoStatusIcon({
  status,
  active,
  theme,
}: TodoStatusIconProps) {
  const isRunning = status === "running";
  const tick = useTick(active && isRunning, 100);
  const todoColor = status === "done"
    ? theme.success
    : isRunning
      ? theme.accent
      : theme.muted;
  const todoIcon = status === "done"
    ? "✓ "
    : isRunning
      ? SPINNER_DOTS[tick % SPINNER_DOTS.length]! + " "
      : "□ ";

  return (
    <Text color={todoColor} bold={isRunning}>
      {todoIcon}
    </Text>
  );
});

interface GoalTodoRowProps {
  todo: GoalTodo;
  active: boolean;
  theme: ThemeTokens;
  todoConnector: string;
  boxyBorder?: boolean;
}

export const GoalTodoRow = memo(function GoalTodoRow({
  todo,
  active,
  theme,
  todoConnector,
  boxyBorder = false,
}: GoalTodoRowProps) {
  const isTodoRunning = todo.status === "running";
  return (
    <Box flexDirection="row">
      {boxyBorder && <Text color={theme.accent} dimColor>│ </Text>}
      <Text color={theme.muted}>
        {todoConnector}
      </Text>
      <TodoStatusIcon status={todo.status} active={active} theme={theme} />
      <Text color={isTodoRunning ? theme.text : theme.muted} dimColor={todo.status === "pending"}>
        {todo.title}
      </Text>
    </Box>
  );
});

interface ActiveSubagentStepRowProps {
  substep: any;
  active: boolean;
  theme: ThemeTokens;
  treeConnector: string;
  boxyBorder?: boolean;
}

export const ActiveSubagentStepRow = memo(function ActiveSubagentStepRow({
  substep,
  active,
  theme,
  treeConnector,
  boxyBorder = false,
}: ActiveSubagentStepRowProps) {
  const isWorking = substep.status === "active";
  const isDone = substep.status === "done";
  const tick = useTick(active && isWorking, 100);
  
  const stepIcon = isDone
    ? "✓ "
    : isWorking
      ? SPINNER_DOTS[tick % SPINNER_DOTS.length]! + " "
      : "□ ";
  const stepColor = isDone
    ? theme.success
    : isWorking
      ? theme.accent
      : theme.muted;

  return (
    <Box flexDirection="row" overflow="hidden">
      {boxyBorder && <Text color={theme.accent} dimColor>│ </Text>}
      <Text color={theme.accent}>
        {treeConnector}
      </Text>
      <Text color={stepColor} bold={isWorking}>
        {stepIcon}
      </Text>
      <Box flexGrow={1} overflow="hidden">
        {formatTechnicalSubLine(substep.label, theme)}
      </Box>
    </Box>
  );
});

interface EnergyBorderProps {
  borderType: "top" | "bottom";
  width: number;
  active: boolean;
  theme: ThemeTokens;
  offset?: number;
}

export const EnergyBorder = memo(function EnergyBorder({
  borderType,
  width,
  active,
  theme,
  offset = 0,
}: EnergyBorderProps) {
  const tick = useTick(active, 100);
  const bar = energyBar(width, tick + offset);
  const left = borderType === "top" ? "╭" : "╰";
  const right = borderType === "top" ? "╮" : "╯";
  return (
    <Text color={theme.accent} dimColor>
      {left}{bar}{right}
    </Text>
  );
});

interface AnimatedAccentDividerProps {
  width: number;
  active: boolean;
  theme: ThemeTokens;
  offset?: number;
}

export const AnimatedAccentDivider = memo(function AnimatedAccentDivider({
  width,
  active,
  theme,
  offset = 0,
}: AnimatedAccentDividerProps) {
  const tick = useTick(active, 100);
  return (
    <Text color={theme.accent} dimColor>
      │{accentDivider(width, tick + offset)}│
    </Text>
  );
});

interface EnergyBarProps {
  width: number;
  active: boolean;
  theme: ThemeTokens;
  offset?: number;
}

export const EnergyBar = memo(function EnergyBar({
  width,
  active,
  theme,
  offset = 0,
}: EnergyBarProps) {
  const tick = useTick(active, 100);
  const bar = energyBar(width, tick + offset);
  return (
    <Text color={theme.accent} dimColor>
      {bar}
    </Text>
  );
});

interface OrchestrationStepRowProps {
  step: GoalStep;
  active: boolean;
  theme: ThemeTokens;
  isBlocked: boolean;
  blockedByStep?: GoalStep;
  activeSubagents?: any[];
  tokenCount?: number;
  treeConnector: string;
  boxyBorder?: boolean;
}

export const OrchestrationStepRow = memo(function OrchestrationStepRow({
  step,
  active,
  theme,
  isBlocked,
  blockedByStep,
  activeSubagents = [],
  tokenCount = 0,
  treeConnector,
  boxyBorder = false,
}: OrchestrationStepRowProps) {
  const isRunning = step.status === "running";
  const isDone = step.status === "done";
  const isError = step.status === "error";

  const tick = useTick(active && isRunning, 100);
  const spinner = SPINNER_DOTS[tick % SPINNER_DOTS.length]!;

  let statusIcon = "[□]";
  let statusColor = theme.muted;
  let statusTextSuffix = "";
  let boldText = false;
  let dimText = true;

  if (isDone) {
    statusIcon = "[✓]";
    statusColor = theme.success;
    dimText = true;
    const durSec = step.durationMs ? (step.durationMs / 1000).toFixed(1) : "0.0";
    statusTextSuffix = ` · completed in ${durSec}s (${step.toolcallsCount ?? 1} toolcalls)`;
  } else if (isRunning) {
    statusIcon = `[${spinner}]`;
    statusColor = theme.accent;
    boldText = true;
    dimText = false;
    statusTextSuffix = step.progressStatus ? ` · ${step.progressStatus}` : " · active";
  } else if (isError) {
    statusIcon = "[✕]";
    statusColor = theme.danger;
    boldText = true;
    dimText = false;
    statusTextSuffix = " · failed";
  } else if (isBlocked) {
    statusIcon = "[⤎]";
    statusColor = theme.warning;
    dimText = true;
    statusTextSuffix = blockedByStep ? ` · blocked ➔ depends on Phase ${blockedByStep.id}` : " · blocked";
  } else {
    statusIcon = "[□]";
    statusColor = theme.muted;
    dimText = true;
    statusTextSuffix = " · queued";
  }

  // Active subagent working on this phase
  const currentSubagent = activeSubagents?.find((sa) => sa.status === "running");

  return (
    <Box flexDirection="column" marginBottom={0}>
      <Box flexDirection="row">
        {boxyBorder && <Text color={theme.accent} dimColor>│ </Text>}
        <Text color={theme.accent}>{treeConnector}</Text>
        <Text color={statusColor} bold={boldText}>
          {statusIcon}{" "}
        </Text>
        <Text color={dimText ? theme.muted : theme.text} bold={boldText} dimColor={dimText}>
          Phase {step.id}: {step.title}
        </Text>
        <Text color={isBlocked ? theme.warning : theme.muted} dimColor={!isBlocked}>
          {statusTextSuffix}
        </Text>
      </Box>

      {/* Expanded details when running */}
      {isRunning && (
        <Box flexDirection="column">
          {/* Subagent Executor */}
          {currentSubagent && (
            <Box flexDirection="row">
              {boxyBorder && <Text color={theme.accent} dimColor>│ </Text>}
              <Text color={theme.accent}>│   ├── </Text>
              <Text color={theme.text} bold>⚙ Executor: </Text>
              <Text color={theme.accent} bold>worker.{currentSubagent.agentId.slice(0, 8)} </Text>
              <Text color={theme.muted}>
                ({formatElapsed(currentSubagent.elapsedMs ?? 0)}
                {tokenCount > 0 ? ` · ${(tokenCount / 1000).toFixed(1)}k tokens` : ""}
                )
              </Text>
            </Box>
          )}

          {/* Subagent state/phase */}
          {currentSubagent && currentSubagent.phase && (
            <Box flexDirection="row">
              {boxyBorder && <Text color={theme.accent} dimColor>│ </Text>}
              <Text color={theme.accent}>│   ├── </Text>
              <Text color={theme.text} bold>⚙ State: </Text>
              <Text color={theme.warning}>{currentSubagent.phase}</Text>
            </Box>
          )}

          {/* Subagent steps */}
          {currentSubagent && currentSubagent.steps && currentSubagent.steps.length > 0 && (
            <Box flexDirection="column">
              <Box flexDirection="row">
                {boxyBorder && <Text color={theme.accent} dimColor>│ </Text>}
                <Text color={theme.accent}>│   ├── </Text>
                <Text color={theme.text} bold>⚙ Activity Log:</Text>
              </Box>
              {currentSubagent.steps.slice(-3).map((substep: any, sIdx: number) => {
                const currentSlice = currentSubagent.steps.slice(-3);
                const isLastSub = sIdx === currentSlice.length - 1;
                const subConnector = isLastSub ? "│   │   └── " : "│   │   ├── ";
                return (
                  <ActiveSubagentStepRow
                    key={sIdx}
                    substep={substep}
                    active={active}
                    theme={theme}
                    treeConnector={subConnector}
                    boxyBorder={boxyBorder}
                  />
                );
              })}
            </Box>
          )}

          {/* Checklist Todos */}
          {step.todos && step.todos.length > 0 && (
            <Box flexDirection="column">
              <Box flexDirection="row">
                {boxyBorder && <Text color={theme.accent} dimColor>│ </Text>}
                <Text color={theme.accent}>│   └── </Text>
                <Text color={theme.text} bold>📋 Checklist:</Text>
              </Box>
              {step.todos.map((todo, tIdx) => {
                const isLastTodo = tIdx === step.todos!.length - 1;
                const todoConnector = isLastTodo ? "│       └── " : "│       ├── ";
                return (
                  <GoalTodoRow
                    key={todo.id}
                    todo={todo}
                    active={active}
                    theme={theme}
                    todoConnector={todoConnector}
                    boxyBorder={boxyBorder}
                  />
                );
              })}
            </Box>
          )}
        </Box>
      )}
    </Box>
  );
});

interface GoalTimerTextProps {
  startMs: number;
  active: boolean;
  theme: ThemeTokens;
}

export const GoalTimerText = memo(function GoalTimerText({
  startMs,
  active,
  theme,
}: GoalTimerTextProps) {
  const [elapsed, setElapsed] = useState(() => Date.now() - startMs);

  useEffect(() => {
    if (!active) return;
    const interval = setInterval(() => {
      setElapsed(Date.now() - startMs);
    }, 1000); // 1Hz tick for display timing is highly optimal
    return () => clearInterval(interval);
  }, [startMs, active]);

  return <Text color={theme.success} bold>{formatElapsed(elapsed)} elapsed</Text>;
});

export const GoalRunner = memo(function GoalRunner({
  theme,
  task,
  steps,
  currentStep,
  totalSteps,
  startMs,
  active,
  viewMode = "flat",
  maxVisibleSteps = 10,
  subagents = [],
  tokenCount = 0,
}: GoalRunnerProps) {
  const doneCount = steps.filter((s) => s.status === "done").length;
  const pct = totalSteps > 0 ? Math.round((doneCount / totalSteps) * 100) : 0;

  // Scroll window to focus on current running or last done step
  let start = 0;
  if (steps.length > maxVisibleSteps) {
    const runIdx = steps.findIndex((s) => s.status === "running");
    const anchor = runIdx >= 0 ? runIdx : doneCount;
    start = Math.max(0, Math.min(anchor - 3, steps.length - maxVisibleSteps));
  }
  const visibleSteps = steps.slice(start, start + maxVisibleSteps);
  const innerWidth = 60;

  if (viewMode === "flat") {
    return (
      <Box flexDirection="column" marginBottom={0} marginLeft={2} marginTop={1}>
        {/* Sleek Flat List Header */}
        <Box marginBottom={1} flexDirection="row">
          <Text color={theme.accent} bold>⎔ ORCHESTRATION GRAPH </Text>
          <Text color={theme.muted}>[</Text>
          <Text color={theme.text} bold>{totalSteps} Phases</Text>
          <Text color={theme.muted}>]</Text>
          <Text color={theme.muted}> · </Text>
          <Text color={theme.text}>
            {doneCount}/{totalSteps} complete ({pct}%)
          </Text>
          <Text color={theme.muted}> · </Text>
          <GoalTimerText startMs={startMs} active={active} theme={theme} />
        </Box>

        {/* Flat List Steps as a dynamic tree */}
        <Box flexDirection="column" marginBottom={1}>
          {visibleSteps.map((step, sIdx) => {
            const isLast = sIdx === visibleSteps.length - 1;
            const treeConnector = isLast ? "└── " : "├── ";
            const isStepBlocked = step.status === "pending" && steps.some((s) => s.id < step.id && s.status !== "done");
            const blockedByStep = isStepBlocked ? steps.find((s) => s.id < step.id && s.status !== "done") : undefined;

            return (
              <OrchestrationStepRow
                key={step.id}
                step={step}
                active={active}
                theme={theme}
                isBlocked={isStepBlocked}
                blockedByStep={blockedByStep}
                activeSubagents={subagents}
                tokenCount={tokenCount}
                treeConnector={treeConnector}
                boxyBorder={false}
              />
            );
          })}
        </Box>

        <Box marginTop={0} flexDirection="row">
          <Text color={theme.muted}>[tab] switch layout · esc abort goal</Text>
        </Box>
      </Box>
    );
  }

  // Classic Boxy Layout but structured as a living Execution Graph
  return (
    <Box flexDirection="column" marginBottom={0} marginLeft={1} marginTop={1}>
      {/* Top border with energy */}
      <EnergyBorder borderType="top" width={innerWidth} active={active} theme={theme} />

      {/* Header */}
      <Box>
        <Text color={theme.accent} dimColor>│ </Text>
        <Text color={theme.accent} bold>⎔ ORCHESTRATION GRAPH</Text>
        <Text color={theme.muted}> — </Text>
        <Text color={theme.text} bold wrap="wrap">
          {task}
        </Text>
      </Box>

      {/* Divider */}
      <AnimatedAccentDivider width={innerWidth} active={active} theme={theme} />

      {/* Stats row inside the box */}
      <Box flexDirection="row">
        <Text color={theme.accent} dimColor>│ </Text>
        <Text color={theme.success}>● Running Goal </Text>
        <Text color={theme.muted}>
          ({doneCount}/{totalSteps} phases done · {pct}% ·{" "}
        </Text>
        <GoalTimerText startMs={startMs} active={active} theme={theme} />
        <Text color={theme.muted}>)</Text>
      </Box>

      {/* Divider */}
      <AnimatedAccentDivider width={innerWidth} active={active} theme={theme} offset={10} />

      {/* Steps inside the Box as a nested tree */}
      <Box flexDirection="column">
        {visibleSteps.map((step, sIdx) => {
          const isLast = sIdx === visibleSteps.length - 1;
          const treeConnector = isLast ? "└── " : "├── ";
          const isStepBlocked = step.status === "pending" && steps.some((s) => s.id < step.id && s.status !== "done");
          const blockedByStep = isStepBlocked ? steps.find((s) => s.id < step.id && s.status !== "done") : undefined;

          return (
            <OrchestrationStepRow
              key={step.id}
              step={step}
              active={active}
              theme={theme}
              isBlocked={isStepBlocked}
              blockedByStep={blockedByStep}
              activeSubagents={subagents}
              tokenCount={tokenCount}
              treeConnector={treeConnector}
              boxyBorder={true}
            />
          );
        })}
      </Box>

      {/* Divider */}
      <AnimatedAccentDivider width={innerWidth} active={active} theme={theme} offset={20} />

      {/* Footer */}
      <Box>
        <Text color={theme.accent} dimColor>│ </Text>
        {active ? (
          <SpinnerText
            label={`Running task phase ${currentStep}`}
            theme={theme}
          />
        ) : (
          <Text color={theme.success} bold>
            ● Goal execution complete
          </Text>
        )}
        <Text color={theme.muted}> · tab switch layout · esc abort</Text>
      </Box>

      {/* Bottom border */}
      <EnergyBorder borderType="bottom" width={innerWidth} active={active} theme={theme} offset={25} />
    </Box>
  );
});
