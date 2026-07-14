import { useState } from "react";
import { Box, Text, useInput } from "ink";
import type { ThemeTokens } from "../themes/registry.js";
import { useTerminalLayout } from "../layout/TerminalLayoutProvider.js";
import { EventBus } from "@agency/core";

export interface LiveGrillOverlayProps {
  theme: ThemeTokens;
  payload: {
    agentId?: string;
    conversationId?: string;
    consecutiveFailures: number;
    lastModifiedFiles?: string[];
  };
  onClose: () => void;
}

export function LiveGrillOverlay({
  theme,
  payload,
  onClose,
}: LiveGrillOverlayProps) {
  const { cols } = useTerminalLayout();
  const [phase, setPhase] = useState<"menu" | "input">("menu");
  const [feedback, setFeedback] = useState("");

  const handleResume = (action: "continue" | "rollback" | "abort", text?: string) => {
    void EventBus.getInstance().publish("loop:resume", {
      agentId: payload.agentId,
      conversationId: payload.conversationId,
      action,
      feedback: text,
    });
    onClose();
  };

  useInput((input, key) => {
    if (phase === "menu") {
      if (input.toLowerCase() === "c") {
        setPhase("input");
        return;
      }
      if (input.toLowerCase() === "r") {
        handleResume("rollback");
        return;
      }
      if (input.toLowerCase() === "a" || key.escape) {
        handleResume("abort");
        return;
      }
    } else if (phase === "input") {
      if (key.escape) {
        setPhase("menu");
        return;
      }
      if (key.return) {
        const trimmed = feedback.trim();
        if (trimmed) {
          handleResume("continue", trimmed);
        }
        return;
      }

      const isBackspace =
        key.backspace ||
        input === "\b" ||
        input === "\x08" ||
        input === "\x7f";

      if (isBackspace) {
        setFeedback((prev) => prev.slice(0, -1));
        return;
      }

      if (
        key.upArrow ||
        key.downArrow ||
        key.leftArrow ||
        key.rightArrow ||
        key.tab ||
        input.includes("\x1b") ||
        input.charCodeAt(0) < 32
      ) {
        return;
      }

      setFeedback((prev) => prev + input);
    }
  });

  const overlayWidth = Math.min(cols - 4, 65);
  const innerWidth = overlayWidth - 6;
  const dividerStr = "─".repeat(Math.max(0, innerWidth));

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={theme.danger}
      paddingX={2}
      width={overlayWidth}
      overflow="hidden"
    >
      <Box marginTop={1} overflow="hidden">
        <Text bold color={theme.danger}>
          ⚠️ Loop Warning: Stuck Agent Detected
        </Text>
      </Box>
      <Text color={theme.dimBorder}>{dividerStr}</Text>

      <Box flexDirection="column" marginY={1} overflow="hidden">
        <Text color={theme.text}>
          The agent has failed/repeated identical actions{" "}
          <Text bold color={theme.danger}>
            {payload.consecutiveFailures}
          </Text>{" "}
          times consecutively.
        </Text>
        {payload.lastModifiedFiles && payload.lastModifiedFiles.length > 0 ? (
          <Box flexDirection="column" marginTop={1} overflow="hidden">
            <Text color={theme.muted} bold>
              Modified Files:
            </Text>
            {payload.lastModifiedFiles.map((file, idx) => (
              <Text key={idx} color={theme.warning}>
                • {file.split(/[/\\]/).pop() || file}
              </Text>
            ))}
          </Box>
        ) : null}
      </Box>

      <Text color={theme.dimBorder}>{dividerStr}</Text>

      {phase === "menu" ? (
        <Box flexDirection="column" marginY={1} overflow="hidden">
          <Text color={theme.text} bold>
            Choose course of action:
          </Text>
          <Box flexDirection="column" marginTop={1} overflow="hidden">
            <Text color={theme.text}>
              <Text bold color={theme.accent}>
                [C]
              </Text>{" "}
              Steer: Give guidance to help the agent get unstuck.
            </Text>
            <Text color={theme.text}>
              <Text bold color={theme.warning}>
                [R]
              </Text>{" "}
              Rollback: Revert changes to modified files and abort.
            </Text>
            <Text color={theme.text}>
              <Text bold color={theme.danger}>
                [A]
              </Text>{" "}
              Abort: Terminate the agent turn immediately.
            </Text>
          </Box>
        </Box>
      ) : (
        <Box flexDirection="column" marginY={1} overflow="hidden">
          <Text color={theme.text} bold>
            Enter Steering Instructions:
          </Text>
          <Box
            borderStyle="single"
            borderColor={theme.dimBorder}
            paddingX={1}
            marginTop={1}
            overflow="hidden"
          >
            <Text color={theme.text}>
              {feedback || "e.g. Try using string replace instead of regex"}
            </Text>
          </Box>
        </Box>
      )}

      <Text color={theme.dimBorder}>{dividerStr}</Text>
      <Box marginBottom={1} overflow="hidden">
        <Text color={theme.muted}>
          {phase === "menu"
            ? "Press C, R, A or Esc to abort"
            : "Enter submit steering · Esc cancel"}
        </Text>
      </Box>
    </Box>
  );
}
