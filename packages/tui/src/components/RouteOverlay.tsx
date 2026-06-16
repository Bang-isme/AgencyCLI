import { useState } from "react";
import { Box, Text, useInput } from "ink";
import type { ThemeTokens } from "../themes/registry.js";
import { useTerminalLayout } from "../layout/TerminalLayoutProvider.js";
import { panelWidth } from "../layout/terminal-layout.js";

export interface RouteOverlayProps {
  theme: ThemeTokens;
  lastPrompt: string | null;
  onSelect: (prompt: string, intent: string) => void;
  onClose: () => void;
}

interface IntentOption {
  name: string;
  value: string;
  desc: string;
}

const ROUTE_INTENTS: IntentOption[] = [
  { name: "debug", value: "debug", desc: "Code debugging, AST analysis, and triage workflows" },
  { name: "review", value: "review", desc: "Commit, branch, diff, pull request, or CI workflows" },
  { name: "compact", value: "compact", desc: "Interactive prompt history compaction and compression" },
  { name: "index", value: "index", desc: "Workspace symbol indexing and knowledge-graph refresh" },
  { name: "schedule", value: "schedule", desc: "Recurring cron-like scheduler tasks" },
  { name: "Custom...", value: "custom", desc: "Input and configure any other custom intent label" },
];

export function RouteOverlay({
  theme,
  lastPrompt,
  onSelect,
  onClose,
}: RouteOverlayProps) {
  const { cols } = useTerminalLayout();
  const overlayWidth = panelWidth(cols, 72, 40);
  const innerWidth = overlayWidth - 4;
  const dividerStr = "─".repeat(Math.max(0, innerWidth));

  // Step 1: Enter prompt (if lastPrompt is null). Step 2: Select intent.
  const [step, setStep] = useState(() => (lastPrompt ? 2 : 1));
  const [typedPrompt, setTypedPrompt] = useState("");
  const [index, setIndex] = useState(0);
  const [customActive, setCustomActive] = useState(false);
  const [customIntent, setCustomIntent] = useState("");

  const activePrompt = lastPrompt || typedPrompt;
  const safe = ROUTE_INTENTS.length === 0 ? 0 : index % ROUTE_INTENTS.length;

  useInput((_input, key) => {
    if (key.escape) {
      if (step === 2 && !lastPrompt && !customActive) {
        // Go back to step 1
        setStep(1);
      } else if (customActive) {
        setCustomActive(false);
      } else {
        onClose();
      }
      return;
    }

    // Step 1: Type custom prompt
    if (step === 1) {
      const isBackspace = key.backspace || key.delete || (key as any).name === "backspace" || (key as any).name === "delete" || _input === "\b" || _input === "\x08" || _input === "\x7f";
      if (key.return) {
        const trimmed = typedPrompt.trim();
        if (trimmed) {
          setStep(2);
        }
      } else if (isBackspace) {
        setTypedPrompt((s) => s.slice(0, -1));
      } else if (_input && !key.ctrl && !key.meta) {
        setTypedPrompt((s) => s + _input);
      }
      return;
    }

    // Step 2: Custom intent input
    if (customActive) {
      const isBackspace = key.backspace || key.delete || (key as any).name === "backspace" || (key as any).name === "delete" || _input === "\b" || _input === "\x08" || _input === "\x7f";
      if (key.return) {
        const trimmed = customIntent.trim().toLowerCase();
        if (trimmed && activePrompt) {
          onSelect(activePrompt, trimmed);
        }
      } else if (isBackspace) {
        setCustomIntent((s) => s.slice(0, -1));
      } else if (_input && !key.ctrl && !key.meta) {
        if (/^[a-zA-Z0-9_-]$/.test(_input)) {
          setCustomIntent((s) => s + _input);
        }
      }
      return;
    }

    // Step 2: Intent list navigation
    if (key.upArrow || _input === "k") {
      setIndex((i) => (i === 0 ? ROUTE_INTENTS.length - 1 : i - 1));
      return;
    }
    if (key.downArrow || _input === "j") {
      setIndex((i) => (i === ROUTE_INTENTS.length - 1 ? 0 : i + 1));
      return;
    }
    if (key.return) {
      const selected = ROUTE_INTENTS[safe];
      if (selected && selected.value === "custom") {
        setCustomActive(true);
      } else if (selected && activePrompt) {
        onSelect(activePrompt, selected.value);
      }
    }
  });

  const promptSnippet = activePrompt
    ? (activePrompt.length > 50 ? `${activePrompt.slice(0, 47)}...` : activePrompt)
    : "";

  let footerHint = "";
  if (step === 1) {
    footerHint = "Type custom prompt keyword/sample · Enter to proceed · Esc close";
  } else if (customActive) {
    footerHint = "Type custom intent name · Enter to save · Esc back to list";
  } else {
    footerHint = `Enter select · ↑↓ navigate · Esc ${lastPrompt ? "close" : "back to Step 1"}`;
  }

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={theme.success}
      paddingX={2}
      paddingY={0}
      width={overlayWidth}
    >
      <Box flexDirection="column" marginTop={1} overflow="hidden">
        <Text color={theme.success} bold wrap="wrap">🎯 Route Feedback Self-Learning Wizard</Text>
        <Text color={theme.dimBorder}>{dividerStr}</Text>
      </Box>

      {step === 1 ? (
        <Box flexDirection="column" marginY={1} overflow="hidden">
          <Text color={theme.warning} bold>✏️ Step 1: No active prompt found in session history.</Text>
          <Box marginTop={1}>
            <Text color={theme.text}>Please enter the sample prompt or keywords you want to train:</Text>
          </Box>
          <Box flexDirection="row" marginTop={1} borderStyle="single" borderColor={theme.dimBorder} paddingX={1} width="100%">
            <Text color={theme.accent}>▸ </Text>
            <Text color={theme.text} bold>{typedPrompt}</Text>
            <Text color={theme.accent}>█</Text>
          </Box>
        </Box>
      ) : (
        <Box flexDirection="column" overflow="hidden">
          {/* Header Info */}
          <Box flexDirection="column" overflow="hidden">
            <Box flexDirection="row" gap={1} overflow="hidden">
              <Text color={theme.muted} wrap="wrap">Active Prompt:</Text>
              <Text color={theme.text} bold wrap="wrap">"{promptSnippet}"</Text>
            </Box>
            <Box flexDirection="row" gap={1} overflow="hidden">
              <Text color={theme.muted} wrap="wrap">Target Config:</Text>
              <Text color={theme.muted} wrap="wrap">.agency/routing-weights.json</Text>
            </Box>
          </Box>

          <Text color={theme.dimBorder}>{dividerStr}</Text>

          {customActive ? (
            <Box flexDirection="column" marginY={1} overflow="hidden">
              <Text color={theme.accent} bold>✏️ Enter custom intent label:</Text>
              <Box flexDirection="row" marginTop={1}>
                <Text color={theme.accent}>▸ </Text>
                <Text color={theme.text} bold>{customIntent}</Text>
                <Text color={theme.accent}>█</Text>
              </Box>
            </Box>
          ) : (
            <Box flexDirection="column" marginY={0} overflow="hidden">
              <Box marginBottom={1}>
                <Text color={theme.success} bold>🎯 Step 2: Select Target Intent</Text>
              </Box>
              {ROUTE_INTENTS.map((item, i) => {
                const sel = i === safe;
                return (
                  <Box key={item.name} flexDirection="row" alignItems="center" height={1} overflow="hidden">
                    <Box width={3}>
                      <Text color={sel ? theme.accent : theme.muted}>
                        {sel ? "▸" : " "}
                      </Text>
                    </Box>
                    <Box width={12}>
                      <Text color={sel ? theme.text : theme.muted} bold={sel} wrap="wrap">
                        {item.name}
                      </Text>
                    </Box>
                    <Box flexGrow={1} flexShrink={1}>
                      <Text color={sel ? theme.text : theme.muted} dimColor={!sel} wrap="wrap">
                        {item.desc}
                      </Text>
                    </Box>
                  </Box>
                );
              })}
            </Box>
          )}
        </Box>
      )}

      <Text color={theme.dimBorder}>{dividerStr}</Text>
      <Box marginBottom={1} overflow="hidden">
        <Text color={theme.muted} dimColor wrap="wrap">
          {footerHint}
        </Text>
      </Box>
    </Box>
  );
}
