import { memo } from "react";
import { Box, Text } from "ink";
import { capabilityRegistry } from "@agency/core";
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




export const SlashMenu = memo(function SlashMenu({
  theme,
  items,
  index,
  visible,
}: SlashMenuProps) {
  const { composerWidth, composerInnerWidth, rows } = useTerminalLayout();
  const descWidth = Math.max(8, composerInnerWidth - NAME_WIDTH - 6);

  if (!visible || items.length === 0) {
    return null;
  }

  const maxVisible = rows < 22 ? 2 : rows < 26 ? 3 : rows < 30 ? 4 : 6;
  const safe = Math.max(0, Math.min(index, items.length - 1));

  let start = 0;
  if (items.length > maxVisible) {
    start = Math.max(0, Math.min(safe - 2, items.length - maxVisible));
  }
  const visibleItems = items.slice(start, start + maxVisible);
  const hasMore = items.length > maxVisible;

  const rowsList: JSX.Element[] = [];
  for (let vi = 0; vi < maxVisible; vi++) {
    const item = visibleItems[vi];
    if (item) {
      const realIndex = start + vi;
      const selected = realIndex === safe;
      const icon = item.icon ?? capabilityRegistry.get(item.name)?.icon ?? "·";
      rowsList.push(
        <Box key={vi} flexDirection="row" height={1} overflow="hidden">
          <Box width={2}>
            <Text color={selected ? theme.accent : theme.muted}>
              {selected ? ">" : " "}
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
      rowsList.push(
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
      height={maxVisible + 3}
      width={composerWidth}
      overflow="hidden"
    >
      <Text color={theme.muted} dimColor>
        /{hasMore ? ` ${items.length} commands` : " commands"}
      </Text>
      {rowsList}
    </Box>
  );
});
