import { useState, useEffect, useMemo } from "react";
import { Box, Text, useInput, useApp } from "ink";
import type { ThemeTokens } from "../themes/registry.js";
import { useTick } from "../motion/useTick.js";
import { AGENCY_SPINNER } from "../motion/design-system.js";
import { GlowingLogo } from "./GlowingLogo.js";
import { useTerminalLayout } from "../layout/TerminalLayoutProvider.js";

export interface SplashProps {
  theme: ThemeTokens;
  version?: string;
  project?: string;
  skillsPath?: string;
  onDone: () => void;
  durationMs?: number;
}

function shortPath(path: string, max = 32): string {
  if (path.length <= max) return path;
  return `…${path.slice(-(max - 1))}`;
}

const CHECKS = [
  { id: "skills", label: "skills bridge" },
  { id: "project", label: "workspace context" },
  { id: "providers", label: "llm providers" },
  { id: "runtime", label: "node engine" },
] as const;

export interface ScanningDividerProps {
  width: number;
  tick: number;
  theme: ThemeTokens;
  phaseOffset?: number;
}

export function ScanningDivider({ width, tick, theme, phaseOffset = 0 }: ScanningDividerProps) {
  const cycle = width * 2;
  let pos = (tick + phaseOffset) % cycle;
  if (pos >= width) {
    pos = cycle - pos;
  }

  const leftBorderCount = Math.max(0, pos - 1);
  const leftBorderStr = "─".repeat(leftBorderCount);

  const hasLeftDot = pos > 0;
  const leftDotStr = hasLeftDot ? "┄" : "";

  const arrowStr = "→";

  const hasRightDot = pos < width - 1;
  const rightDotStr = hasRightDot ? "┄" : "";

  const rightBorderCount = Math.max(0, width - pos - 2);
  const rightBorderStr = "─".repeat(rightBorderCount);

  return (
    <Box flexDirection="row">
      {leftBorderStr ? <Text color={theme.dimBorder}>{leftBorderStr}</Text> : null}
      {leftDotStr ? <Text color={theme.muted}>{leftDotStr}</Text> : null}
      <Text color={theme.highlight} bold>{arrowStr}</Text>
      {rightDotStr ? <Text color={theme.muted}>{rightDotStr}</Text> : null}
      {rightBorderStr ? <Text color={theme.dimBorder}>{rightBorderStr}</Text> : null}
    </Box>
  );
}

interface GlitchLogoProps {
  logo: string[];
  tick: number;
  theme: ThemeTokens;
  stage: number;
}

export function GlitchLogo({ logo, tick, theme, stage }: GlitchLogoProps) {
  const isExitGlitch = stage === -1;
  const resolvePct = isExitGlitch
    ? 0.3
    : stage === 0 ? 0 : stage === 1 ? 0.2 : stage === 2 ? 0.4 : stage === 3 ? 0.6 : stage === 4 ? 0.8 : 1.0;

  const sweepCol = (tick * 1.5) % 100;

  return (
    <Box flexDirection="column">
      {logo.map((line, rowIdx) => {
        const chars = line.split("");
        return (
          <Box key={rowIdx} flexDirection="row">
            {chars.map((char, colIdx) => {
              const isResolved = isExitGlitch
                ? (Math.random() < 0.2 + 0.3 * Math.sin((tick + colIdx) * 0.5))
                : (colIdx / chars.length <= resolvePct && Math.random() < 0.94 + resolvePct * 0.06);

              let displayChar = char;
              let color = theme.accent;
              const isShadow = char === "░";

              if (!isResolved) {
                const glitchChars = ["█", "▓", "▒", "░", "▄", "▀", "▌", "▐", "▘", "▝", "▗", "▖", " "];
                displayChar = glitchChars[(tick + colIdx + rowIdx) % glitchChars.length]!;
                if (isExitGlitch) {
                  const glitchColors = [theme.accent, theme.warning, theme.success, theme.dimBorder];
                  color = glitchColors[(tick + colIdx + rowIdx) % glitchColors.length]!;
                } else {
                  color = theme.dimBorder;
                }
              } else {
                const dist = Math.abs(colIdx - sweepCol);
                if (dist < 3) {
                  color = theme.warning;
                  if (displayChar !== " ") {
                    displayChar = "█";
                  }
                } else if (dist < 6) {
                  color = theme.accent;
                } else {
                  color = isShadow ? theme.dimBorder : theme.accent;
                }
              }

              return (
                <Text key={colIdx} color={color} bold={!isShadow && isResolved}>
                  {displayChar}
                </Text>
              );
            })}
          </Box>
        );
      })}
    </Box>
  );
}

const getExitLogLine = (index: number): string => {
  const logs = [
    "→ Establishing secure communications...",
    "✓ Decrypted system credentials",
    "✓ Workspace memory allocated",
    "✓ Provider endpoint verification passed",
    "→ Spawning cognitive execution layers...",
    "✓ Injecting runtime skills hooks",
    "✓ Secure local client socket ready",
    "→ Verifying workspace integrity...",
    "✓ Environment verification completed",
    "→ Launching agent operating system...",
  ];
  return logs[index % logs.length]!;
};

/**
 * BIOS System Control Dashboard Splash screen.
 */
export function Splash({
  theme,
  version = "0.1.0",
  project = process.cwd(),
  skillsPath,
  onDone,
  durationMs = 2800,
}: SplashProps) {
  const { shellWidth, shellHeight, cols, rows } = useTerminalLayout();
  const { exit } = useApp();

  const [ready, setReady] = useState(false);
  const [stage, setStage] = useState(0);
  const [stageStartTicks, setStageStartTicks] = useState<Record<number, number>>({});
  const [exitTickCount, setExitTickCount] = useState<number | null>(null);

  const tick = useTick(true, 50);

  useInput((input, key) => {
    if (key.ctrl && input === "c") {
      exit();
      return;
    }
    if (ready && exitTickCount === null) {
      setExitTickCount(0);
    }
  });

  useEffect(() => {
    const delays = [120, 500, 800, 1100, 1400, 1800];
    const timers = delays.map((ms, i) =>
      setTimeout(() => setStage(i + 1), ms)
    );
    const readyTimer = setTimeout(() => setReady(true), Math.floor(durationMs * 0.75));
    return () => {
      timers.forEach(clearTimeout);
      clearTimeout(readyTimer);
    };
  }, [durationMs]);

  useEffect(() => {
    setStageStartTicks((prev) => ({ ...prev, [stage]: tick }));
  }, [stage]);

  useEffect(() => {
    if (exitTickCount !== null) {
      if (exitTickCount >= 12) {
        onDone();
      } else {
        setExitTickCount((c) => (c !== null ? c + 1 : null));
      }
    }
  }, [tick]);

  const values = useMemo(() => ({
    skills: skillsPath ? shortPath(skillsPath, 16) : "resolving…",
    project: shortPath(project, 16),
    providers: "auto-detect",
    runtime: `${process.platform}-${process.arch}`,
  }), [skillsPath, project]);

  const spinner = AGENCY_SPINNER[tick % AGENCY_SPINNER.length];
  const dots = ".".repeat(Math.floor(tick / 4) % 4);

  const iconCycle = ["◈", "◇", "❖", "✦", "✧", "⬪", "⬩", "⬧"];
  const headerIcon = iconCycle[Math.floor(tick / 4) % iconCycle.length];

  const currentBorderColor = theme.border;

  const splashWidth = Math.max(30, Math.min(74, cols - 2));
  const innerWidth = splashWidth - 6;
  const isNarrow = cols < 65 || rows < 22;
  const colW = Math.max(10, Math.floor((innerWidth - 4) / 2));

  return (
    <Box
      flexDirection="column"
      height={shellHeight}
      width={shellWidth}
      alignItems="center"
      justifyContent="center"
    >
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor={currentBorderColor}
        width={splashWidth}
        paddingX={2}
      >
        {/* Header Title */}
        <Box justifyContent="space-between" paddingBottom={0} overflow="hidden">
          <Text color={theme.accent} bold wrap="truncate">{headerIcon} {cols < 65 ? "AGENCY" : "AGENCY SYSTEM KERNEL"}</Text>
          <Text color={theme.success} bold wrap="truncate">
            <Text color={tick % 16 < 8 ? theme.success : theme.accent}>●</Text> ONLINE
          </Text>
        </Box>

        {/* Divider */}
        <ScanningDivider width={innerWidth} tick={tick} theme={theme} phaseOffset={0} />

        {/* Logo Section */}
        <Box flexDirection="column" alignItems="center" paddingY={1}>
          <GlowingLogo theme={theme} tick={tick} />
          <Box marginTop={1} overflow="hidden">
            <Text color={theme.muted} wrap="truncate">
              {cols < 65 ? `v${version}` : `c o m m a n d   l i n e   i n t e r f a c e   v${version}`}
            </Text>
          </Box>
        </Box>

        {/* Divider */}
        <ScanningDivider width={innerWidth} tick={tick} theme={theme} phaseOffset={15} />

        {/* Telemetry Columns or Exit Decryption Logs */}
        {exitTickCount !== null ? (
          <Box flexDirection="column" paddingY={1} height={isNarrow ? 5 : 7} overflow="hidden">
            {Array.from({ length: isNarrow ? 3 : 5 }).map((_, i) => {
              const lineIndex = exitTickCount + i;
              const lineText = getExitLogLine(lineIndex);
              let color = theme.text;
              if (lineText.startsWith("✓")) color = theme.success;
              else if (lineText.startsWith("→")) color = theme.highlight;
              return (
                <Text key={i} color={color} wrap="truncate">
                  {lineText.slice(0, innerWidth).padEnd(innerWidth)}
                </Text>
              );
            })}
          </Box>
        ) : !isNarrow ? (
          <Box flexDirection="row" justifyContent="space-between" paddingY={1} height={7} overflow="hidden">
            {/* Left Column: Diagnostics / Boot Sequence */}
            <Box flexDirection="column" width={colW} overflow="hidden">
              <Text color={theme.accent} bold wrap="truncate">● Diagnostics</Text>
              {CHECKS.map((check, idx) => {
                const checkStage = idx + 2;
                const isActiveNow = stage === checkStage && !ready;
                const isDone = stage > checkStage || ready;
                
                let progress = 0;
                if (isDone) {
                  progress = 100;
                } else if (isActiveNow) {
                  const startTick = stageStartTicks[checkStage];
                  if (startTick !== undefined) {
                    const durationTicks = checkStage === 5 ? 8 : 6;
                    const elapsed = tick - startTick;
                    progress = Math.min(99, Math.floor((elapsed / durationTicks) * 100));
                  }
                }

                const barWidth = Math.max(2, colW - 27);
                const filledChars = Math.round((progress / 100) * barWidth);
                const emptyChars = barWidth - filledChars;
                const barText = "■".repeat(filledChars) + "▪".repeat(emptyChars);

                let statusColor = theme.muted;
                let statusStr = "";

                if (isDone) {
                  statusColor = theme.success;
                  statusStr = `✓ [${barText}]`;
                } else if (isActiveNow) {
                  statusColor = theme.warning;
                  const pctStr = `${progress}%`.padStart(3);
                  statusStr = `→ [${barText}] ${pctStr}`;
                } else {
                  statusColor = theme.muted;
                  statusStr = `○ [${barText}]`;
                }
                
                return (
                  <Box key={check.id} flexDirection="row" overflow="hidden">
                    <Text color={theme.text} wrap="truncate">{check.label.padEnd(colW - 16).slice(0, colW - 16)}</Text>
                    <Text color={statusColor} wrap="truncate">{statusStr.padStart(16).slice(0, 16)}</Text>
                  </Box>
                );
              })}
            </Box>

            {/* Vertical divider inside columns */}
            <Box borderStyle="single" borderLeft borderRight={false} borderTop={false} borderBottom={false} borderColor={theme.dimBorder} marginX={2} />

            {/* Right Column: Telemetry values */}
            <Box flexDirection="column" width={colW} overflow="hidden">
              <Text color={theme.accent} bold wrap="truncate">● Environment</Text>
              <Box flexDirection="row" overflow="hidden">
                <Text color={theme.text} wrap="truncate">{"project".padEnd(colW - 20).slice(0, colW - 20)}</Text>
                <Text color={theme.muted} wrap="truncate">{values.project.padStart(20).slice(0, 20)}</Text>
              </Box>
              <Box flexDirection="row" overflow="hidden">
                <Text color={theme.text} wrap="truncate">{"runtime".padEnd(colW - 20).slice(0, colW - 20)}</Text>
                <Text color={theme.muted} wrap="truncate">{values.runtime.padStart(20).slice(0, 20)}</Text>
              </Box>
              <Box flexDirection="row" overflow="hidden">
                <Text color={theme.text} wrap="truncate">{"providers".padEnd(colW - 20).slice(0, colW - 20)}</Text>
                <Text color={theme.muted} wrap="truncate">{values.providers.padStart(20).slice(0, 20)}</Text>
              </Box>
              <Box flexDirection="row" overflow="hidden">
                <Text color={theme.text} wrap="truncate">{"skills".padEnd(colW - 20).slice(0, colW - 20)}</Text>
                <Text color={theme.muted} wrap="truncate">{values.skills.padStart(20).slice(0, 20)}</Text>
              </Box>
            </Box>
          </Box>
        ) : (
          <Box height={5} />
        )}

        {/* Divider */}
        <ScanningDivider width={innerWidth} tick={tick} theme={theme} phaseOffset={30} />

        {/* Status Footer */}
        <Box justifyContent="center" paddingBottom={1} overflow="hidden">
          {exitTickCount !== null ? (
            <Text color={theme.warning} bold wrap="truncate">
              → Launching execution kernel...
            </Text>
          ) : ready ? (
            <Text color={theme.success} bold wrap="truncate">
              {cols < 65 ? "● Kernel ready · Press any key" : "● Kernel ready · Press any key to initialize runtime"}
            </Text>
          ) : (
            <Text color={theme.warning} bold wrap="truncate">
              {spinner} {cols < 65 ? "Booting runtime" : "Initializing orchestration runtime"}{dots}
            </Text>
          )}
        </Box>
      </Box>
    </Box>
  );
}
