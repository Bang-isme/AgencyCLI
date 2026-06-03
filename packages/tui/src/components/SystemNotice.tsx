import { memo, useMemo } from "react";
import { Box, Text } from "ink";
import type { ThemeTokens } from "../themes/registry.js";

const HELP_NOISE = [
  "Slash commands:",
  "Shortcuts:",
  "Ctrl+P palette",
  "/doctor",
  "/connect",
  "agency config init",
  "Edit ~/.agency/config.json",
];

function isHelpDump(content: string): boolean {
  const hits = HELP_NOISE.filter((n) => content.includes(n)).length;
  return hits >= 2;
}

export function formatSystemNotice(content: string): string {
  if (isHelpDump(content)) {
    return "Type ? for help · Type / for slash commands";
  }

  const lines = content.split("\n");
  const filtered = lines.filter((line) => {
    const t = line.trim();
    if (!t) return false;
    if (t.startsWith("/") && t.length < 40) return false;
    return !HELP_NOISE.some((noise) => t.startsWith(noise) || t.includes(noise));
  });
  if (filtered.length === 0) {
    const first = content.split("\n")[0]?.trim();
    return first && first.length < 120 ? first : content.slice(0, 120);
  }
  const joined = filtered.join("\n");
  return joined.length > 240 ? `${joined.slice(0, 237)}…` : joined;
}

export interface SystemNoticeProps {
  theme: ThemeTokens;
  content: string;
  hideHeader?: boolean;
}

function renderTuxCard(content: string, theme: ThemeTokens): JSX.Element | null {
  // 1. Schedule Card
  if (content.includes("Schedule added:") || content.includes("⏲ Schedule added:")) {
    const taskMatch = content.match(/Schedule added:\s*["']([^"']+)["']\s*\(([^)]+)\)/);
    const workflowMatch = content.match(/workflow:\s*(\S+)/);
    const cronMatch = content.match(/cron:\s*([^\s·]+)/);
    const fileMatch = content.match(/file:\s*([^\n\r]+)/);

    const task = taskMatch?.[1] || "task";
    const id = taskMatch?.[2] || "sched-id";
    const workflow = workflowMatch?.[1] || "review";
    const cron = cronMatch?.[1]?.replace("every:", "every ") || "every 1m";
    const file = fileMatch?.[1] || "schedules.json";

    return (
      <Box flexDirection="column" borderStyle="round" borderColor={theme.accent} paddingX={1} marginY={0} width="100%">
        <Box flexDirection="row" justifyContent="space-between">
          <Text color={theme.accent} bold>Recurring task scheduled</Text>
          <Text color={theme.muted} dimColor>[{id}]</Text>
        </Box>
        <Text color={theme.dimBorder}>──────────────────────────────────────────────────</Text>
        <Box flexDirection="row">
          <Box width={12}>
            <Text color={theme.muted}>• Workflow: </Text>
          </Box>
          <Text color={theme.success} bold>{workflow}</Text>
        </Box>
        <Box flexDirection="row">
          <Box width={12}>
            <Text color={theme.muted}>• Interval: </Text>
          </Box>
          <Text color={theme.warning}>{cron}</Text>
        </Box>
        <Box flexDirection="row">
          <Box width={12}>
            <Text color={theme.muted}>• Target: </Text>
          </Box>
          <Text color={theme.text} bold>"{task}"</Text>
        </Box>
        <Box flexDirection="row">
          <Box width={12}>
            <Text color={theme.muted}>• Config: </Text>
          </Box>
          <Text color={theme.muted} wrap="truncate-middle">{file}</Text>
        </Box>
      </Box>
    );
  }

  // 2. Index Card
  if (content.includes("✦ Indexed") || content.includes("Indexed")) {
    const filesMatch = content.match(/Indexed\s*(\d+)\s*files/);
    const durationMatch = content.match(/\((\d+ms)\)/);
    
    const lines = content.split("\n");
    const langLine = lines.find(l => l.includes(":") && !l.includes("Indexed") && !l.includes("workflow"));
    const languages = langLine?.trim() || "";

    const filesCount = filesMatch?.[1] || "0";
    const duration = durationMatch?.[1] || "0ms";

    return (
      <Box flexDirection="column" borderStyle="round" borderColor={theme.success} paddingX={1} marginY={0} width="100%">
        <Box flexDirection="row" justifyContent="space-between">
          <Text color={theme.success} bold>✦ Codebase indexed</Text>
        </Box>
        <Text color={theme.dimBorder}>──────────────────────────────────────────────────</Text>
        <Box flexDirection="row">
          <Box width={16}>
            <Text color={theme.muted}>• Files Scanned: </Text>
          </Box>
          <Text color={theme.text} bold>{filesCount}</Text>
        </Box>
        <Box flexDirection="row">
          <Box width={16}>
            <Text color={theme.muted}>• Duration: </Text>
          </Box>
          <Text color={theme.warning}>{duration}</Text>
        </Box>
        {languages ? (
          <Box flexDirection="row">
            <Box width={16}>
              <Text color={theme.muted}>• Languages: </Text>
            </Box>
            <Text color={theme.accent}>{languages}</Text>
          </Box>
        ) : null}
      </Box>
    );
  }

  // 3. Dashboard Opened Card
  if (content.includes("Opened Memory Dashboard") || content.includes("Memory Dashboard")) {
    const urlMatch = content.match(/URL:\s*([^\n\r]+)/);
    const pathMatch = content.match(/Path:\s*([^\n\r]+)/);

    const url = urlMatch?.[1]?.trim() || "";
    const path = pathMatch?.[1]?.trim() || "";

    return (
      <Box flexDirection="column" borderStyle="round" borderColor={theme.accent} paddingX={1} marginY={0} width="100%">
        <Box flexDirection="row" justifyContent="space-between">
          <Text color={theme.accent} bold>Memory dashboard opened</Text>
        </Box>
        <Text color={theme.dimBorder}>──────────────────────────────────────────────────</Text>
        <Box flexDirection="row">
          <Box width={10}>
            <Text color={theme.muted}>• URL: </Text>
          </Box>
          <Text color={theme.accent} underline wrap="truncate">{url}</Text>
        </Box>
        <Box flexDirection="row">
          <Box width={10}>
            <Text color={theme.muted}>• Path: </Text>
          </Box>
          <Text color={theme.muted} wrap="truncate-middle">{path}</Text>
        </Box>
      </Box>
    );
  }

  // 4. Routing Feedback Card
  if (content.includes("Recorded feedback:") || content.includes("✓ Recorded feedback:")) {
    const intentMatch = content.match(/intent\s*["']([^"']+)["']/i);
    const promptMatch = content.match(/Prompt:\s*["']([^"']+)["']/);

    const intent = intentMatch?.[1] || "debug";
    const prompt = promptMatch?.[1] || "";

    return (
      <Box flexDirection="column" borderStyle="round" borderColor={theme.success} paddingX={1} marginY={0} width="100%">
        <Box flexDirection="row" justifyContent="space-between">
          <Text color={theme.success} bold>Routing feedback recorded</Text>
        </Box>
        <Text color={theme.dimBorder}>──────────────────────────────────────────────────</Text>
        <Box flexDirection="row">
          <Box width={16}>
            <Text color={theme.muted}>• Target Intent: </Text>
          </Box>
          <Text color={theme.success} bold>{intent}</Text>
        </Box>
        <Box flexDirection="row">
          <Box width={16}>
            <Text color={theme.muted}>• Linked Prompt: </Text>
          </Box>
          <Text color={theme.text} wrap="truncate-middle">"{prompt}"</Text>
        </Box>
        <Box flexDirection="row">
          <Box width={16}>
            <Text color={theme.muted}>• Storage Config: </Text>
          </Box>
          <Text color={theme.muted}>.agency/routing-weights.json</Text>
        </Box>
      </Box>
    );
  }

  // 5. Active Routing Weights Card
  if (content.includes("Active Routing Weights:") || content.includes("✓ Active Routing Weights:")) {
    const pathMatch = content.match(/Path:\s*([^\n\r]+)/);
    const totalMatch = content.match(/Total Feedbacks:\s*(\d+)/);
    const path = pathMatch?.[1]?.trim() || ".agency/routing-weights.json";
    const total = totalMatch?.[1] || "0";

    // Extract individual signals
    const signalLines = content.split("\n")
      .filter(l => l.trim().startsWith("- "))
      .map(l => l.trim().slice(2));

    return (
      <Box flexDirection="column" borderStyle="round" borderColor={theme.accent} paddingX={1} marginY={0} width="100%">
        <Box flexDirection="row" justifyContent="space-between">
          <Text color={theme.accent} bold>Routing weights</Text>
        </Box>
        <Text color={theme.dimBorder}>──────────────────────────────────────────────────</Text>
        <Box flexDirection="row">
          <Box width={16}>
            <Text color={theme.muted}>• Config Path: </Text>
          </Box>
          <Text color={theme.text} wrap="truncate-middle">{path}</Text>
        </Box>
        <Box flexDirection="row">
          <Box width={16}>
            <Text color={theme.muted}>• Feedbacks Count: </Text>
          </Box>
          <Text color={theme.warning} bold>{total}</Text>
        </Box>
        {signalLines.length > 0 && (
          <Box flexDirection="column" marginTop={1}>
            <Text color={theme.muted} bold>Active Dispatch Signals:</Text>
            {signalLines.slice(0, 5).map((sig, idx) => (
              <Text key={idx} color={theme.text}>  • {sig}</Text>
            ))}
            {signalLines.length > 5 && (
              <Text color={theme.muted}>  ... and {signalLines.length - 5} more signals</Text>
            )}
          </Box>
        )}
      </Box>
    );
  }

  // 6. Routing Warning Card (No prompts)
  if (content.includes("No natural-language user prompts found")) {
    return (
      <Box flexDirection="column" borderStyle="round" borderColor={theme.warning} paddingX={1} marginY={0} width="100%">
        <Box flexDirection="row" justifyContent="space-between">
          <Text color={theme.warning} bold>▲ Routing feedback needs a prompt first</Text>
        </Box>
        <Text color={theme.dimBorder}>──────────────────────────────────────────────────</Text>
        <Text color={theme.text} bold>To record routing feedback, you must first enter a natural-language question or prompt in this session.</Text>
        <Box flexDirection="column" marginTop={1}>
          <Text color={theme.muted}>For example:</Text>
          <Text color={theme.accent}>  1. Type: "write a unit test for routing"</Text>
          <Text color={theme.accent}>  2. Then type: "/route feedback debug"</Text>
        </Box>
        <Box marginTop={1}>
          <Text color={theme.muted}>This lets the router link your prompt's keywords to the correct intent.</Text>
        </Box>
      </Box>
    );
  }

  return null;
}

export const SystemNotice = memo(function SystemNotice({ theme, content, hideHeader = false }: SystemNoticeProps) {
  const isShellCmd = useMemo(() => content.startsWith("$ "), [content]);
  const formatted = useMemo(() => formatSystemNotice(content), [content]);

  const isSubagent = useMemo(() => {
    return /subagent/i.test(content) || /spawned/i.test(content) || /orchestrator/i.test(content) || /reviewer/i.test(content);
  }, [content]);

  const isThinkingOrExplore = useMemo(() => {
    return /thinking/i.test(content) || /thought/i.test(content) || /exploring/i.test(content) || /explore/i.test(content) || /analyzing/i.test(content);
  }, [content]);

  const headerText = isSubagent
    ? "◈ Subagent"
    : isThinkingOrExplore
      ? "◈ Thinking"
      : "◈ System";

  const headerColor = isSubagent
    ? theme.accent
    : isThinkingOrExplore
      ? theme.warning
      : theme.muted;

  const borderColor = isSubagent
    ? theme.accent
    : isThinkingOrExplore
      ? theme.warning
      : theme.dimBorder;

  const textColor = isSubagent
    ? theme.text
    : isThinkingOrExplore
      ? theme.text
      : theme.muted;

  const tuxCard = useMemo(() => renderTuxCard(content, theme), [content, theme]);

  if (tuxCard) {
    return (
      <Box flexDirection="column" marginY={1}>
        {!hideHeader && (
          <Box marginLeft={2} marginBottom={0}>
            <Text color={headerColor} bold dimColor>
              {headerText}
            </Text>
          </Box>
        )}
        <Box marginLeft={1}>
          {tuxCard}
        </Box>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" marginY={0}>
      {!hideHeader && (
        <Box marginLeft={2} marginBottom={0}>
          <Text color={headerColor} bold={isSubagent || isThinkingOrExplore} dimColor={!isSubagent && !isThinkingOrExplore}>
            {headerText}
          </Text>
        </Box>
      )}
      <Box
        borderStyle="single"
        borderColor={borderColor}
        borderLeft
        borderRight={false}
        borderTop={false}
        borderBottom={false}
        paddingLeft={1}
        marginLeft={1}
      >
        {isShellCmd ? (
          <Text wrap="wrap">
            <Text color={theme.accent} bold>$ </Text>
            <Text color={textColor}>{formatted.slice(2)}</Text>
          </Text>
        ) : (
          <Text color={textColor} wrap="wrap">
            {formatted}
          </Text>
        )}
      </Box>
    </Box>
  );
});


