import React, { memo, useState, useEffect } from "react";
import { Box, Text } from "ink";
import type { ThemeTokens } from "../../themes/registry.js";
import { SPINNER_DOTS } from "../../motion/design-system.js";
import { useTick } from "../../motion/useTick.js";
import { getLoopLag } from "../../terminal/screen.js";
import {
  getToolAlias,
  getGroundedTargetName,
  getSemanticToolOperation,
  toPastTense
} from "../../utils/conversation/tool-labels.js";

// Stateful cache for tool targets
export const lastToolTargets = new Map<string, string>();

export interface RetryCountdownMsgProps {
  message: string;
  theme: ThemeTokens;
}

export const RetryCountdownMsg = memo(function RetryCountdownMsg({
  message,
  theme,
}: RetryCountdownMsgProps) {
  const match = message.match(/Retrying in (\d+(?:\.\d+)?)s/);
  const initialSeconds = match ? parseFloat(match[1]!) : 0;
  const [secondsLeft, setSecondsLeft] = useState(initialSeconds);

  useEffect(() => {
    setSecondsLeft(initialSeconds);
  }, [initialSeconds]);

  useEffect(() => {
    if (initialSeconds <= 0) return;
    const start = Date.now();
    let tickInterval = 100;
    const lag = getLoopLag();
    if (lag > 200) {
      tickInterval = 1000;
    } else if (lag > 100) {
      tickInterval = 500;
    } else if (lag > 50) {
      tickInterval = 200;
    }

    const interval = setInterval(() => {
      const elapsed = (Date.now() - start) / 1000;
      const next = Math.max(0, initialSeconds - elapsed);
      setSecondsLeft(next);
      if (next <= 0) {
        clearInterval(interval);
      }
    }, tickInterval);
    return () => clearInterval(interval);
  }, [initialSeconds]);

  if (initialSeconds <= 0) {
    return <Text color={theme.warning}>{message}</Text>;
  }

  const updatedMessage = message.replace(/Retrying in \d+(?:\.\d+)?s/, `Retrying in ${secondsLeft.toFixed(1)}s`);
  return <Text color={theme.warning}>{updatedMessage}</Text>;
});

export interface SystemActivityLineProps {
  line: string;
  theme: ThemeTokens;
  isActive: boolean;
  expandedTui: boolean;
}

export const SystemActivityLine = memo(function SystemActivityLine({
  line,
  theme,
  isActive,
  expandedTui,
}: SystemActivityLineProps) {
  const tick = useTick(isActive, 100);

  // Strip any leading ⚡ or ◆ or whitespace
  const cleanLine = line.replace(/^[⚡◆\s]+/, "").trim();

  const spinnerFrame = SPINNER_DOTS[tick % SPINNER_DOTS.length];
  const bullet = isActive ? (
    <Text color={theme.accent} bold>{spinnerFrame} </Text>
  ) : (
    <Text color={theme.muted}>→ </Text>
  );

  // Pattern 1: Spawning specialist
  if (cleanLine.includes("Spawning specialist")) {
    const match = cleanLine.match(/Spawning specialist (.+?)\.\.\./);
    const worker = match ? match[1] : "specialist";
    return (
      <Box flexDirection="row">
        {bullet}
        <Text color={theme.muted}>Spawning specialist </Text>
        <Text color={theme.muted} bold>{worker}</Text>
      </Box>
    );
  }

  // Pattern 2: Executing tool
  if (cleanLine.includes("Executing tool")) {
    const match = cleanLine.match(/Executing tool "([a-zA-Z0-9_-]+)"(?:\s+on\s+(.+?))?(?:\s+with\s+arguments\s+(.+?))?\.\.\./);
    if (match) {
      const toolName = match[1]!;
      const target = match[2] || "";
      const args = match[3] ?? "";

      if (target) {
        lastToolTargets.set(toolName, target);
      } else if (args) {
        lastToolTargets.set(toolName, args);
      }

      const semanticOp = expandedTui
        ? `${getToolAlias(toolName)} ➔ ${target || args}`
        : getSemanticToolOperation(toolName, args, target);

      return (
        <Box flexDirection="row">
          {bullet}
          <Text color={theme.muted} bold={expandedTui}>{semanticOp}</Text>
        </Box>
      );
    }
  }

  // Pattern 3: Tool completed
  if (cleanLine.includes("completed with result length")) {
    const match = cleanLine.match(/Tool "([a-zA-Z0-9_-]+)" completed with result length: (\d+) characters\./);
    if (match) {
      const toolName = match[1]!;
      const len = match[2];
      const prevTarget = lastToolTargets.get(toolName) || "";
      const semanticOp = expandedTui
        ? `${getToolAlias(toolName)} completed (${len} chars)`
        : toPastTense(getSemanticToolOperation(toolName, "", prevTarget));
      return (
        <Box flexDirection="row">
          <Text color={theme.success}>✓ </Text>
          <Text color={theme.muted}>{semanticOp}</Text>
        </Box>
      );
    }
  }

  // Pattern 4: Running auto-verification
  if (cleanLine.includes("Running auto-verification")) {
    const match = cleanLine.match(/Running auto-verification \((.+?)\)\.\.\./);
    const gate = match ? match[1] : "verification";
    return (
      <Box flexDirection="row">
        {isActive ? (
          <Text color={theme.warning} bold>{spinnerFrame} </Text>
        ) : (
          <Text color={theme.warning}>→ </Text>
        )}
        <Text color={theme.muted}>Running build & compile checks ({gate})...</Text>
      </Box>
    );
  }

  // Pattern 5: Verification passed
  if (cleanLine.includes("Verification passed successfully")) {
    return (
      <Box flexDirection="row">
        <Text color={theme.success}>✓ </Text>
        <Text color={theme.muted} bold>Build & compilation integrity verified</Text>
      </Box>
    );
  }

  // Pattern 6: Verification failed
  if (cleanLine.includes("Verification failed! Re-routing")) {
    return (
      <Box flexDirection="row">
        <Text color={theme.danger}>✕ </Text>
        <Text color={theme.muted} bold>Integrity check failed ➔ Entering recovery self-healing loop</Text>
      </Box>
    );
  }

  // Pattern 7: Retrying / Countdown
  if (cleanLine.includes("Retrying in")) {
    const displayMsg = cleanLine.replace(/^\[SYSTEM WARNING:\s*/i, "■ ").replace(/^\[SYSTEM:\s*/i, "◈ ").replace(/\]$/, "");
    return (
      <Box flexDirection="row">
        <RetryCountdownMsg message={displayMsg} theme={theme} />
      </Box>
    );
  }

  // Fallback for other [SYSTEM: lines
  if (cleanLine.includes("[SYSTEM:") || cleanLine.includes("[SYSTEM WARNING:")) {
    const displayMsg = cleanLine.replace(/^\[SYSTEM WARNING:\s*/i, "■ ").replace(/^\[SYSTEM:\s*/i, "◈ ").replace(/\]$/, "");
    return (
      <Box flexDirection="row">
        <Text color={theme.muted}>{displayMsg}</Text>
      </Box>
    );
  }

  return null;
});

export function toConciseTelemetry(line: string, theme: ThemeTokens, isActive = false, tick = 0): React.ReactNode {
  const cleanLine = line.replace(/^[⚡◆\s]+/, "").trim();
  const spinnerFrame = SPINNER_DOTS[tick % SPINNER_DOTS.length];

  if (cleanLine.includes("Spawning specialist")) {
    const match = cleanLine.match(/Spawning specialist (.+?)\.\.\./);
    const worker = match ? match[1] : "specialist";
    return (
      <Box flexDirection="row">
        <Text color={theme.accent}>{isActive ? `${spinnerFrame} ` : "▶ "}</Text>
        <Text color={theme.muted}>worker · spawning · </Text>
        <Text color={theme.text} bold>{worker}</Text>
      </Box>
    );
  }

  if (cleanLine.includes("Executing tool")) {
    const match = cleanLine.match(/Executing tool "([a-zA-Z0-9_-]+)"(?:\s+on\s+(.+?))?(?:\s+with\s+arguments\s+(.+?))?\.\.\./);
    if (match) {
      const toolName = match[1]!;
      const target = match[2] || "";
      const args = match[3] ?? "";
      const displayTarget = target ? getGroundedTargetName(target) : (args ? getGroundedTargetName(args) : "");
      return (
        <Box flexDirection="row">
          <Text color={theme.accent}>{isActive ? `${spinnerFrame} ` : "▶ "}</Text>
          <Text color={theme.muted}>{`exec · ${getToolAlias(toolName)}`}</Text>
          {displayTarget ? <Text color={theme.muted}> · </Text> : null}
          {displayTarget ? <Text color={theme.text} bold wrap="truncate">{displayTarget}</Text> : null}
        </Box>
      );
    }
  }

  if (cleanLine.includes("completed with result length")) {
    const match = cleanLine.match(/Tool "([a-zA-Z0-9_-]+)" completed with result length: (\d+) characters\./);
    if (match) {
      const toolName = match[1]!;
      return (
        <Box flexDirection="row">
          <Text color={theme.success}>✓ </Text>
          <Text color={theme.muted}>{`exec · ${getToolAlias(toolName)} · completed`}</Text>
        </Box>
      );
    }
  }

  if (cleanLine.includes("Running auto-verification")) {
    return (
      <Box flexDirection="row">
        <Text color={theme.warning}>{isActive ? `${spinnerFrame} ` : `${SPINNER_DOTS[0]} `}</Text>
        <Text color={theme.muted}>verify · building</Text>
      </Box>
    );
  }

  if (cleanLine.includes("Verification passed successfully")) {
    return (
      <Box flexDirection="row">
        <Text color={theme.success}>✓ </Text>
        <Text color={theme.muted}>verify · passed</Text>
      </Box>
    );
  }

  if (cleanLine.includes("Verification failed! Re-routing")) {
    return (
      <Box flexDirection="row">
        <Text color={theme.danger}>✕ </Text>
        <Text color={theme.muted}>verify · failed</Text>
      </Box>
    );
  }

  if (cleanLine.includes("Retrying in")) {
    const match = cleanLine.match(/Retrying in (\d+(?:\.\d+)?)s/);
    const time = match ? `${match[1]}s` : "";
    return (
      <Box flexDirection="row">
        <Text color={theme.warning}>⚠ </Text>
        <Text color={theme.muted}>{`retry · retrying ${time ? `in ${time}` : ""}`}</Text>
      </Box>
    );
  }

  // Fallback
  const displayMsg = cleanLine.replace(/^\[SYSTEM WARNING:\s*/i, "").replace(/^\[SYSTEM:\s*/i, "").replace(/\]$/, "");
  return (
    <Box flexDirection="row">
      <Text color={theme.muted}>→ </Text>
      <Text color={theme.muted} wrap="truncate">{displayMsg}</Text>
    </Box>
  );
}

export function formatSystemActivityLine(
  line: string,
  theme: ThemeTokens,
  isActive = false,
  tick = 0,
  expandedTui = false
): React.ReactNode | null {
  // Strip any leading ⚡ or ◆ or whitespace
  const cleanLine = line.replace(/^[⚡◆\s]+/, "").trim();

  const spinnerFrame = SPINNER_DOTS[tick % SPINNER_DOTS.length];
  const bullet = isActive ? (
    <Text color={theme.accent} bold>{spinnerFrame} </Text>
  ) : (
    <Text color={theme.muted}>→ </Text>
  );

  // Pattern 1: Spawning specialist
  if (cleanLine.includes("Spawning specialist")) {
    const match = cleanLine.match(/Spawning specialist (.+?)\.\.\./);
    const worker = match ? match[1] : "specialist";
    return (
      <Box flexDirection="row">
        {bullet}
        <Text color={theme.muted}>Spawning specialist </Text>
        <Text color={theme.muted} bold={expandedTui}>{worker}</Text>
      </Box>
    );
  }

  // Pattern 2: Executing tool
  if (cleanLine.includes("Executing tool")) {
    const match = cleanLine.match(/Executing tool "([a-zA-Z0-9_-]+)"(?:\s+on\s+(.+?))?(?:\s+with\s+arguments\s+(.+?))?\.\.\./);
    if (match) {
      const toolName = match[1]!;
      const target = match[2] || "";
      const args = match[3] ?? "";

      if (target) {
        lastToolTargets.set(toolName, target);
      } else if (args) {
        lastToolTargets.set(toolName, args);
      }

      const semanticOp = expandedTui
        ? `${getToolAlias(toolName)} ➔ ${target || args}`
        : getSemanticToolOperation(toolName, args, target);

      return (
        <Box flexDirection="row">
          {bullet}
          <Text color={theme.muted} bold={expandedTui}>{semanticOp}</Text>
        </Box>
      );
    }
  }

  // Pattern 3: Tool completed
  if (cleanLine.includes("completed with result length")) {
    const match = cleanLine.match(/Tool "([a-zA-Z0-9_-]+)" completed with result length: (\d+) characters\./);
    if (match) {
      const toolName = match[1]!;
      const len = match[2];
      const prevTarget = lastToolTargets.get(toolName) || "";
      const semanticOp = expandedTui
        ? `${getToolAlias(toolName)} completed (${len} chars)`
        : toPastTense(getSemanticToolOperation(toolName, "", prevTarget));
      return (
        <Box flexDirection="row">
          <Text color={theme.success}>✓ </Text>
          <Text color={theme.muted}>{semanticOp}</Text>
        </Box>
      );
    }
  }

  // Pattern 4: Running auto-verification
  if (cleanLine.includes("Running auto-verification")) {
    const match = cleanLine.match(/Running auto-verification \((.+?)\)\.\.\./);
    const gate = match ? match[1] : "verification";
    return (
      <Box flexDirection="row">
        {isActive ? (
          <Text color={theme.warning} bold>{spinnerFrame} </Text>
        ) : (
          <Text color={theme.warning}>→ </Text>
        )}
        <Text color={theme.muted}>Running build & compile checks ({gate})...</Text>
      </Box>
    );
  }

  // Pattern 5: Verification passed
  if (cleanLine.includes("Verification passed successfully")) {
    return (
      <Box flexDirection="row">
        <Text color={theme.success}>✓ </Text>
        <Text color={theme.muted} bold>Build & compilation integrity verified</Text>
      </Box>
    );
  }

  // Pattern 6: Verification failed
  if (cleanLine.includes("Verification failed! Re-routing")) {
    return (
      <Box flexDirection="row">
        <Text color={theme.danger}>✕ </Text>
        <Text color={theme.muted} bold>Integrity check failed ➔ Entering recovery self-healing loop</Text>
      </Box>
    );
  }

  // Pattern 7: Retrying / Countdown
  if (cleanLine.includes("Retrying in")) {
    const displayMsg = cleanLine.replace(/^\[SYSTEM WARNING:\s*/i, "■ ").replace(/^\[SYSTEM:\s*/i, "◈ ").replace(/\]$/, "");
    return (
      <Box flexDirection="row">
        <RetryCountdownMsg message={displayMsg} theme={theme} />
      </Box>
    );
  }

  // Fallback for other [SYSTEM: lines
  if (cleanLine.includes("[SYSTEM:") || cleanLine.includes("[SYSTEM WARNING:")) {
    const displayMsg = cleanLine.replace(/^\[SYSTEM WARNING:\s*/i, "■ ").replace(/^\[SYSTEM:\s*/i, "◈ ").replace(/\]$/, "");
    return (
      <Box flexDirection="row">
        <Text color={theme.muted}>{displayMsg}</Text>
      </Box>
    );
  }

  return null;
}
