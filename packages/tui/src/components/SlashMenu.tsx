import { memo } from "react";
import { Box, Text } from "ink";
import type { ThemeTokens } from "../themes/registry.js";
import type { SlashMenuItem } from "../presentation/slash-menu.js";
import { truncateText } from "../layout/terminal-layout.js";
import { useTerminalLayout } from "../layout/TerminalLayoutProvider.js";

export interface SlashMenuProps {
  theme: ThemeTokens;
  items: SlashMenuItem[];
  index: number;
  visible: boolean;
}

const NAME_WIDTH = 14;
const MAX_VISIBLE = 6;

const CMD_ICONS: Record<string, string> = {
  help: "?",
  new: "+",
  connect: "◆",
  models: "▣",
  skills: "◇",
  review: "△",
  resume: "↺",
  project: "◈",
  status: "◎",
  viewstatus: "◎",
  mcp: "⊡",
  theme: "◐",
  themes: "◐",
  index: "⊞",
  compact: "⊟",
  export: "↗",
  exit: "×",
  graph: "◈",
  tasks: "☐",
  goal: "⊕",
  schedule: "◷",
  agents: "⊞",
  plugin: "p",
  variant: "v",
  route: "→",
  dashboard: "▤",
  memory: "▤",
};

export const SlashMenu = memo(function SlashMenu({
  theme,
  items,
  index,
  visible,
}: SlashMenuProps) {
  const { composerWidth, composerInnerWidth } = useTerminalLayout();
  const descWidth = Math.max(8, composerInnerWidth - NAME_WIDTH - 6);

  if (!visible || items.length === 0) {
    return null;
  }

  const safe = Math.max(0, Math.min(index, items.length - 1));

  let start = 0;
  if (items.length > MAX_VISIBLE) {
    start = Math.max(0, Math.min(safe - 2, items.length - MAX_VISIBLE));
  }
  const visibleItems = items.slice(start, start + MAX_VISIBLE);
  const hasMore = items.length > MAX_VISIBLE;

  const rows: JSX.Element[] = [];
  for (let vi = 0; vi < MAX_VISIBLE; vi++) {
    const item = visibleItems[vi];
    if (item) {
      const realIndex = start + vi;
      const selected = realIndex === safe;
      const icon = CMD_ICONS[item.name] ?? "·";
      rows.push(
        <Box key={vi} flexDirection="row" height={1} overflow="hidden">
          <Box width={2}>
            <Text color={selected ? theme.accent : theme.muted}>
              {selected ? "▸" : " "}
            </Text>
          </Box>
          <Box width={2}>
            <Text color={selected ? theme.accent : theme.muted}>{icon}</Text>
          </Box>
          <Box width={NAME_WIDTH}>
            <Text color={selected ? theme.accent : theme.muted}>
              {`/${item.name}`.padEnd(NAME_WIDTH)}
            </Text>
          </Box>
          <Box flexGrow={1} overflow="hidden">
            <Text color={theme.muted}>
              {truncateText(item.desc, descWidth)}
            </Text>
          </Box>
        </Box>
      );
    } else {
      rows.push(
        <Box key={vi} height={1}>
          <Text> </Text>
        </Box>
      );
    }
  }

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={theme.border}
      paddingX={1}
      height={MAX_VISIBLE + 3}
      width={composerWidth}
      overflow="hidden"
    >
      <Text color={theme.muted} dimColor>
        /{hasMore ? ` ${items.length} commands` : " commands"}
      </Text>
      {rows}
    </Box>
  );
});
