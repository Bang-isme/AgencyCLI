import { Box, Text, useInput } from "ink";
import type { ThemeTokens } from "../themes/registry.js";
import { SLASH_MENU } from "../presentation/slash-menu.js";
import {
  dividerRepeat,
  measureTerminal,
} from "../layout/terminal-layout.js";

export interface HelpOverlayProps {
  theme: ThemeTokens;
  cols: number;
  onClose: () => void;
}

const SHORT_DESCS: Record<string, string> = {
  help: "Shortcuts overlay",
  new: "New session",
  connect: "Setup API keys",
  models: "Select model",
  skills: "Browse/inject skills",
  plugin: "View skills pack",
  review: "Review commit/PR/CI",
  sessions: "Manage sessions",
  project: "Switch/add project",
  viewstatus: "System status",
  mcp: "Manage MCP servers",
  theme: "Switch theme",
  variant: "Model thinking budget",
  index: "Refresh @file index",
  compact: "Compact context",
  goal: "Long-running task",
  schedule: "Recurring cron task",
  agents: "View subagents",
  export: "Export session",
  exit: "Quit TUI",
};

export function HelpOverlay({ theme, cols, onClose }: HelpOverlayProps) {
  useInput((input, key) => {
    if (key.escape || input === "?" || (key.ctrl && input === "h")) {
      onClose();
    }
  });

  const layout = measureTerminal(cols);
  const overlayWidth = Math.min(layout.contentWidth, 76);
  const dividerLength = Math.max(2, overlayWidth - 4);
  const useTwoColumns = layout.cols >= 74;

  const renderCommands = () => {
    if (useTwoColumns) {
      const half = Math.ceil(SLASH_MENU.length / 2);
      const leftItems = SLASH_MENU.slice(0, half);
      const rightItems = SLASH_MENU.slice(half);

      const rows: JSX.Element[] = [];
      for (let i = 0; i < half; i++) {
        const left = leftItems[i];
        const right = rightItems[i];

        rows.push(
          <Box key={i} flexDirection="row" justifyContent="space-between" overflow="hidden">
            <Box width="50%" overflow="hidden">
              {left && (
                <Text color={theme.muted} wrap="truncate">
                  <Text color={theme.accent}>/{left.name.padEnd(12)}</Text>
                  {SHORT_DESCS[left.name] ?? left.desc}
                </Text>
              )}
            </Box>
            <Box width="50%" overflow="hidden">
              {right && (
                <Text color={theme.muted} wrap="truncate">
                  <Text color={theme.accent}>/{right.name.padEnd(12)}</Text>
                  {SHORT_DESCS[right.name] ?? right.desc}
                </Text>
              )}
            </Box>
          </Box>
        );
      }
      return <Box flexDirection="column">{rows}</Box>;
    }

    return (
      <Box flexDirection="column">
        {SLASH_MENU.map((item) => (
          <Text key={item.name} color={theme.muted} wrap="truncate">
            <Text color={theme.accent}>/{item.name.padEnd(12)}</Text>
            {SHORT_DESCS[item.name] ?? item.desc}
          </Text>
        ))}
      </Box>
    );
  };

  const shortcuts = [
    { category: "Navigation", items: [
      { keys: "↑ / ↓", desc: "Scroll conversation (when input empty)" },
      { keys: "PageUp / PageDown", desc: "Scroll by page" },
      { keys: "Ctrl+↑ / Ctrl+↓", desc: "Scroll by single line" },
      { keys: "Esc", desc: "Cancel / Close overlay / Abort" },
    ]},
    { category: "Actions", items: [
      { keys: "Enter", desc: "Send message / Confirm selection" },
      { keys: "Tab", desc: "Cycle agent modes (agent/plan/debug/ask)" },
      { keys: "Ctrl+O", desc: "Toggle expand/collapse long content" },
      { keys: "!", desc: "Execute shell command" },
    ]},
    { category: "Overlays & menus", items: [
      { keys: "? / Ctrl+H", desc: "Toggle this help overlay" },
      { keys: "/", desc: "Open slash command menu" },
      { keys: "@", desc: "Open file picker" },
      { keys: "Ctrl+X", desc: "Focus subagent detail view" },
    ]},
    { category: "Session", items: [
      { keys: "Ctrl+Q", desc: "Quit application" },
      { keys: "Ctrl+C", desc: "Force exit" },
    ]},
  ];

  const renderShortcuts = () => {
    return (
      <Box flexDirection="column">
        {shortcuts.map((group) => (
          <Box key={group.category} flexDirection="column" marginBottom={1}>
            <Text color={theme.warning} bold>{group.category}</Text>
            {group.items.map((item, idx) => (
              <Box key={idx} flexDirection="row">
                <Box width={24}>
                  <Text color={theme.text} bold>{item.keys}</Text>
                </Box>
                <Box flexGrow={1}>
                  <Text color={theme.muted}>{item.desc}</Text>
                </Box>
              </Box>
            ))}
          </Box>
        ))}
      </Box>
    );
  };

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={theme.accent}
      paddingX={2}
      width={overlayWidth}
      overflow="hidden"
    >
      <Box flexDirection="row" justifyContent="space-between" marginTop={1}>
        <Text bold color={theme.accent}>
          ✦ Help & Shortcuts
        </Text>
      </Box>
      <Text color={theme.dimBorder}>{dividerRepeat(dividerLength)}</Text>

      <Box marginBottom={1} flexDirection="column" overflow="hidden">
        <Box marginBottom={1}>
          <Text color={theme.muted} dimColor bold>
            KEYBOARD SHORTCUTS
          </Text>
        </Box>
        {renderShortcuts()}
      </Box>

      <Text color={theme.dimBorder}>{dividerRepeat(dividerLength)}</Text>

      <Box marginBottom={1} flexDirection="column" overflow="hidden">
        <Box marginBottom={1}>
          <Text color={theme.muted} dimColor bold>
            SLASH COMMANDS
          </Text>
        </Box>
        {renderCommands()}
      </Box>

      <Text color={theme.dimBorder}>{dividerRepeat(dividerLength)}</Text>
      <Box marginBottom={1} overflow="hidden">
        <Text color={theme.muted} wrap="truncate">
          Press <Text color={theme.text} bold>?</Text> or <Text color={theme.text} bold>Esc</Text> to close
        </Text>
      </Box>
    </Box>
  );
}
