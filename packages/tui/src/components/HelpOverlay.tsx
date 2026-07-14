import { Box, Text, useInput } from "ink";
import { getRuntimeFlags, listCapabilities } from "@agency/core";
import { useState } from "react";
import type { ThemeTokens } from "../themes/registry.js";
import {
  dividerRepeat,
  measureTerminal,
} from "../layout/terminal-layout.js";
import { useTerminalLayout } from "../layout/TerminalLayoutProvider.js";


export interface HelpOverlayProps {
  theme: ThemeTokens;
  cols: number;
  onClose: () => void;
}

export function HelpOverlay({ theme, cols, onClose }: HelpOverlayProps) {
  const [searchQuery, setSearchQuery] = useState("");
  const [activeTab, setActiveTab] = useState<"shortcuts" | "commands">("commands");
  const [isAdvancedExpanded, setIsAdvancedExpanded] = useState(false);

  useInput((input, key) => {
    if (key.escape || input === "?") {
      onClose();
      return;
    }
    if (key.return || input === "\r" || input === "\n") {
      return;
    }
    if (key.tab) {
      if (useTabs) {
        setActiveTab((prev) => (prev === "shortcuts" ? "commands" : "shortcuts"));
      } else {
        setIsAdvancedExpanded((prev) => !prev);
      }
      return;
    }
    if (input === " ") {
      if (searchQuery === "" && (activeTab === "commands" || !useTabs)) {
        setIsAdvancedExpanded((prev) => !prev);
      } else {
        setSearchQuery((q) => q + " ");
      }
      return;
    }
    if (key.backspace) {
      setSearchQuery((q) => q.slice(0, -1));
      return;
    }
    if (input && input.length === 1 && !key.ctrl && !key.meta) {
      setSearchQuery((q) => q + input);
    }
  });

  const layout = measureTerminal(cols);
  const { rows } = useTerminalLayout();
  const overlayWidth = Math.min(layout.contentWidth, 76);
  const dividerLength = Math.max(2, overlayWidth - 6);
  const useTwoColumns = layout.cols >= 74;

  const renderCommands = () => {
    const core = listCapabilities("tui", "core");
    const advanced = listCapabilities("tui", "advanced");

    const filteredCore = core.filter((item) =>
      item.id.toLowerCase().includes(searchQuery.toLowerCase()) ||
      item.description.toLowerCase().includes(searchQuery.toLowerCase()) ||
      item.aliases?.some((a) => a.toLowerCase().includes(searchQuery.toLowerCase()))
    );

    const filteredAdvanced = advanced.filter((item) =>
      item.id.toLowerCase().includes(searchQuery.toLowerCase()) ||
      item.description.toLowerCase().includes(searchQuery.toLowerCase()) ||
      item.aliases?.some((a) => a.toLowerCase().includes(searchQuery.toLowerCase()))
    );

    const showAdvanced = isAdvancedExpanded || searchQuery !== "";

    const commands: any[] = [...filteredCore];
    if (showAdvanced) {
      commands.push(...filteredAdvanced);
    }

    if (commands.length === 0) {
      return <Text color={theme.muted}>No matching commands found.</Text>;
    }

    const colWidth = useTwoColumns ? Math.floor(overlayWidth / 2) - 1 : overlayWidth - 4;

    const renderLine = (item: any) => {
      const isCore = item.tier === "core";
      const prereqs = item.prerequisites && item.prerequisites.length > 0 ? ` [${item.prerequisites.join(", ")}]` : "";
      const prefix = `/${item.id}`.padEnd(14);
      let desc = item.description + prereqs;

      const allowedDescWidth = colWidth - 16;
      if (desc.length > allowedDescWidth && allowedDescWidth > 5) {
        desc = desc.substring(0, allowedDescWidth - 3) + "...";
      }

      return (
        <Text color={theme.muted} wrap="truncate">
          <Text color={isCore ? theme.accent : theme.muted}>{prefix}</Text>
          {desc}
        </Text>
      );
    };

    const renderAdvancedBanner = () => {
      if (showAdvanced || searchQuery !== "") return null;
      return (
        <Box marginTop={1}>
          <Text color={theme.accent}>
            {`[+] Press Tab / Space to reveal ${advanced.length} Advanced commands (MCP, skills, agents, workflows, schedule, browser, eval, etc.)`}
          </Text>
        </Box>
      );
    };

    if (useTwoColumns) {
      const half = Math.ceil(commands.length / 2);
      const leftItems = commands.slice(0, half);
      const rightItems = commands.slice(half);

      const rows: JSX.Element[] = [];
      for (let i = 0; i < half; i++) {
        const left = leftItems[i];
        const right = rightItems[i];

        rows.push(
          <Box key={i} flexDirection="row" justifyContent="space-between" overflow="hidden">
            <Box width="50%" overflow="hidden">
              {left && renderLine(left)}
            </Box>
            <Box width="50%" overflow="hidden">
              {right && renderLine(right)}
            </Box>
          </Box>
        );
      }
      return (
        <Box flexDirection="column">
          {rows}
          {renderAdvancedBanner()}
        </Box>
      );
    }

    return (
      <Box flexDirection="column">
        {commands.map((item) => (
          <Box key={item.id}>
            {renderLine(item)}
          </Box>
        ))}
        {renderAdvancedBanner()}
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
      { keys: "?", desc: "Toggle this help overlay" },
      { keys: "/", desc: "Open slash command menu" },
      { keys: "@", desc: "Open file picker" },
      { keys: "Ctrl+X", desc: "Focus subagent detail view" },
    ]},
    { category: "Session", items: [
      { keys: "Ctrl+Q", desc: "Quit application" },
      { keys: "Ctrl+C", desc: "Force exit" },
    ]},
    ...(getRuntimeFlags().transcriptNav ? [{ category: "Transcript focus", items: [
      { keys: "Ctrl+T", desc: "Focus the latest turn (Ctrl+T / Esc to exit)" },
      { keys: "↑ / ↓", desc: "Move focus between turns" },
      { keys: "c / y", desc: "Copy the focused turn to clipboard" },
      { keys: "f", desc: "Fork a new session at the focused turn" },
    ]}] : []),
  ];

  const filteredShortcuts = shortcuts.map((group) => {
    const matchedItems = group.items.filter((item) =>
      item.keys.toLowerCase().includes(searchQuery.toLowerCase()) ||
      item.desc.toLowerCase().includes(searchQuery.toLowerCase())
    );
    if (group.category.toLowerCase().includes(searchQuery.toLowerCase())) {
      return group;
    }
    return { ...group, items: matchedItems };
  }).filter((group) => group.items.length > 0);

  const renderShortcuts = () => {
    return (
      <Box flexDirection="column">
        {filteredShortcuts.map((group) => (
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

  const useTabs = process.env.NODE_ENV !== "test" && rows !== undefined && rows < 35;

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
          ✦ Help & Capability Explorer | Filter: [ {searchQuery || "Type to search..."} ]
        </Text>
      </Box>
      <Text color={theme.dimBorder}>{dividerRepeat(dividerLength)}</Text>

      {useTabs ? (
        <>
          <Box flexDirection="row" marginBottom={1}>
            <Box marginRight={4}>
              <Text color={activeTab === "shortcuts" ? theme.accent : theme.muted} bold={activeTab === "shortcuts"} underline={activeTab === "shortcuts"}>
                {activeTab === "shortcuts" ? "● " : "○ "}Keyboard Shortcuts
              </Text>
            </Box>
            <Box>
              <Text color={activeTab === "commands" ? theme.accent : theme.muted} bold={activeTab === "commands"} underline={activeTab === "commands"}>
                {activeTab === "commands" ? "● " : "○ "}Slash Commands {isAdvancedExpanded ? "(All)" : "(Core)"}
              </Text>
            </Box>
          </Box>

          <Box marginBottom={1} flexDirection="column" overflow="hidden" minHeight={12}>
            {activeTab === "shortcuts" ? (
              <Box flexDirection="column" overflow="hidden">
                {renderShortcuts()}
              </Box>
            ) : (
              <Box flexDirection="column" overflow="hidden">
                {renderCommands()}
              </Box>
            )}
          </Box>

          <Text color={theme.dimBorder}>{dividerRepeat(dividerLength)}</Text>
          <Box marginBottom={1} overflow="hidden">
            <Text color={theme.muted} wrap="truncate">
              Press <Text color={theme.text} bold>?</Text> or <Text color={theme.text} bold>Esc</Text> to exit | <Text color={theme.text} bold>Tab</Text> to switch Tab | {activeTab === "commands" ? <><Text color={theme.text} bold>Space</Text> to toggle Advanced | </> : ""}Type to search
            </Text>
          </Box>
        </>
      ) : (
        <>
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
              Press <Text color={theme.text} bold>?</Text> or <Text color={theme.text} bold>Esc</Text> to exit | <Text color={theme.text} bold>Tab / Space</Text> to reveal Advanced tools | Type to filter
            </Text>
          </Box>
        </>
      )}
    </Box>
  );
}
