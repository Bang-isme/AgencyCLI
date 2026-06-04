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

/**
 * The classified kind + extracted fields of one `[SYSTEM: …]` activity line.
 * The classification (the `includes` checks + field-extraction regexes) used to
 * be copy-pasted across THREE renderers — the live verbose `SystemActivityLine`,
 * a byte-identical dead `formatSystemActivityLine` (now removed), and the concise
 * `toConciseTelemetry`. Parsing once here is the single canonical mapping
 * (§8.10-E); the renderers differ only in how they present the parsed result.
 */
export interface ParsedSystemActivity {
  kind:
    | "spawn"
    | "exec"
    | "completed"
    | "verify-run"
    | "verify-pass"
    | "verify-fail"
    | "retry"
    | "system"
    | "other";
  cleanLine: string;
  worker?: string;
  toolName?: string;
  target?: string;
  args?: string;
  len?: string;
  summary?: string;
  gate?: string;
}

export function parseSystemActivityLine(line: string): ParsedSystemActivity {
  // Strip any leading ⚡ or ◆ or whitespace.
  const cleanLine = line.replace(/^[⚡◆\s]+/, "").trim();

  if (cleanLine.includes("Spawning specialist")) {
    const m = cleanLine.match(/Spawning specialist (.+?)\.\.\./);
    return { kind: "spawn", cleanLine, worker: m ? m[1]! : "specialist" };
  }
  if (cleanLine.includes("Executing tool")) {
    const m = cleanLine.match(/Executing tool "([a-zA-Z0-9_-]+)"(?:\s+on\s+(.+?))?(?:\s+with\s+arguments\s+(.+?))?\.\.\./);
    if (m) return { kind: "exec", cleanLine, toolName: m[1]!, target: m[2] || "", args: m[3] ?? "" };
  }
  if (cleanLine.includes('" completed')) {
    // New format: a human summary ("42 lines", "exit 0", "1.2 KB").
    let m = cleanLine.match(/Tool "([a-zA-Z0-9_-]+)" completed:\s*(.+?)\s*\]?\s*$/);
    if (m) return { kind: "completed", cleanLine, toolName: m[1]!, summary: m[2]! };
    // Back-compat: the old opaque "result length: N characters" (historical sessions).
    m = cleanLine.match(/Tool "([a-zA-Z0-9_-]+)" completed with result length: (\d+) characters\./);
    if (m) return { kind: "completed", cleanLine, toolName: m[1]!, len: m[2]! };
  }
  // BACK-COMPAT: the per-turn gate-quick verification block that emitted these
  // markers was removed in `3a22f11` (verify now drives EventBus events). Kept so
  // pre-refactor SAVED sessions still render their verify lines — not dead code.
  if (cleanLine.includes("Running auto-verification")) {
    const m = cleanLine.match(/Running auto-verification \((.+?)\)\.\.\./);
    return { kind: "verify-run", cleanLine, gate: m ? m[1]! : "verification" };
  }
  if (cleanLine.includes("Verification passed successfully")) return { kind: "verify-pass", cleanLine };
  if (cleanLine.includes("Verification failed! Re-routing")) return { kind: "verify-fail", cleanLine };
  if (cleanLine.includes("Retrying in")) return { kind: "retry", cleanLine };
  if (cleanLine.includes("[SYSTEM:") || cleanLine.includes("[SYSTEM WARNING:")) return { kind: "system", cleanLine };
  return { kind: "other", cleanLine };
}

export const SystemActivityLine = memo(function SystemActivityLine({
  line,
  theme,
  isActive,
  expandedTui,
}: SystemActivityLineProps) {
  const tick = useTick(isActive, 100);
  const spinnerFrame = SPINNER_DOTS[tick % SPINNER_DOTS.length];
  const bullet = isActive ? (
    <Text color={theme.accent} bold>{spinnerFrame} </Text>
  ) : (
    <Text color={theme.muted}>→ </Text>
  );

  const parsed = parseSystemActivityLine(line);

  switch (parsed.kind) {
    // Pattern 1: Spawning specialist
    case "spawn":
      return (
        <Box flexDirection="row">
          {bullet}
          <Text color={theme.muted}>Spawning specialist </Text>
          <Text color={theme.muted} bold>{parsed.worker}</Text>
        </Box>
      );

    // Pattern 2: Executing tool
    case "exec": {
      const toolName = parsed.toolName!;
      const target = parsed.target ?? "";
      const args = parsed.args ?? "";
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

    // Pattern 3: Tool completed
    case "completed": {
      const toolName = parsed.toolName!;
      // Prefer the meaningful result summary ("42 lines", "exit 0", "1.2 KB");
      // fall back to the old char count for historical sessions. The started line
      // above already showed the target, so no started→completed correlation Map.
      const detail = parsed.summary ?? (parsed.len ? `${parsed.len} chars` : "");
      const base = expandedTui
        ? getToolAlias(toolName)
        : toPastTense(getSemanticToolOperation(toolName, "", ""));
      const semanticOp = detail ? `${base} · ${detail}` : base;
      return (
        <Box flexDirection="row">
          <Text color={theme.success}>✓ </Text>
          <Text color={theme.muted}>{semanticOp}</Text>
        </Box>
      );
    }

    // Pattern 4: Running auto-verification
    case "verify-run":
      return (
        <Box flexDirection="row">
          {isActive ? (
            <Text color={theme.warning} bold>{spinnerFrame} </Text>
          ) : (
            <Text color={theme.warning}>→ </Text>
          )}
          <Text color={theme.muted}>Running build & compile checks ({parsed.gate})...</Text>
        </Box>
      );

    // Pattern 5: Verification passed
    case "verify-pass":
      return (
        <Box flexDirection="row">
          <Text color={theme.success}>✓ </Text>
          <Text color={theme.muted} bold>Build & compilation integrity verified</Text>
        </Box>
      );

    // Pattern 6: Verification failed
    case "verify-fail":
      return (
        <Box flexDirection="row">
          <Text color={theme.danger}>✕ </Text>
          <Text color={theme.muted} bold>Integrity check failed ➔ Entering recovery self-healing loop</Text>
        </Box>
      );

    // Pattern 7: Retrying / Countdown
    case "retry": {
      const displayMsg = parsed.cleanLine.replace(/^\[SYSTEM WARNING:\s*/i, "■ ").replace(/^\[SYSTEM:\s*/i, "◈ ").replace(/\]$/, "");
      return (
        <Box flexDirection="row">
          <RetryCountdownMsg message={displayMsg} theme={theme} />
        </Box>
      );
    }

    // Fallback for other [SYSTEM: lines
    case "system": {
      const displayMsg = parsed.cleanLine.replace(/^\[SYSTEM WARNING:\s*/i, "■ ").replace(/^\[SYSTEM:\s*/i, "◈ ").replace(/\]$/, "");
      return (
        <Box flexDirection="row">
          <Text color={theme.muted}>{displayMsg}</Text>
        </Box>
      );
    }

    default:
      return null;
  }
});

export function toConciseTelemetry(line: string, theme: ThemeTokens, isActive = false, tick = 0): React.ReactNode {
  const spinnerFrame = SPINNER_DOTS[tick % SPINNER_DOTS.length];
  const parsed = parseSystemActivityLine(line);

  switch (parsed.kind) {
    case "spawn":
      return (
        <Box flexDirection="row">
          <Text color={theme.accent}>{isActive ? `${spinnerFrame} ` : "▶ "}</Text>
          <Text color={theme.muted}>worker · spawning · </Text>
          <Text color={theme.text} bold>{parsed.worker}</Text>
        </Box>
      );

    case "exec": {
      const toolName = parsed.toolName!;
      const target = parsed.target ?? "";
      const args = parsed.args ?? "";
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

    case "completed": {
      const detail = parsed.summary ?? (parsed.len ? `${parsed.len} chars` : "completed");
      return (
        <Box flexDirection="row">
          <Text color={theme.success}>✓ </Text>
          <Text color={theme.muted}>{`exec · ${getToolAlias(parsed.toolName!)} · ${detail}`}</Text>
        </Box>
      );
    }

    case "verify-run":
      return (
        <Box flexDirection="row">
          <Text color={theme.warning}>{isActive ? `${spinnerFrame} ` : `${SPINNER_DOTS[0]} `}</Text>
          <Text color={theme.muted}>verify · building</Text>
        </Box>
      );

    case "verify-pass":
      return (
        <Box flexDirection="row">
          <Text color={theme.success}>✓ </Text>
          <Text color={theme.muted}>verify · passed</Text>
        </Box>
      );

    case "verify-fail":
      return (
        <Box flexDirection="row">
          <Text color={theme.danger}>✕ </Text>
          <Text color={theme.muted}>verify · failed</Text>
        </Box>
      );

    case "retry": {
      const match = parsed.cleanLine.match(/Retrying in (\d+(?:\.\d+)?)s/);
      const time = match ? `${match[1]}s` : "";
      return (
        <Box flexDirection="row">
          <Text color={theme.warning}>⚠ </Text>
          <Text color={theme.muted}>{`retry · retrying ${time ? `in ${time}` : ""}`}</Text>
        </Box>
      );
    }

    default: {
      // "system" + "other": concise catch-all (strip any [SYSTEM:] framing).
      const displayMsg = parsed.cleanLine.replace(/^\[SYSTEM WARNING:\s*/i, "").replace(/^\[SYSTEM:\s*/i, "").replace(/\]$/, "");
      return (
        <Box flexDirection="row">
          <Text color={theme.muted}>→ </Text>
          <Text color={theme.muted} wrap="truncate">{displayMsg}</Text>
        </Box>
      );
    }
  }
}
