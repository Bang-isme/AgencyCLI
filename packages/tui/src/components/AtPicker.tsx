import { memo } from "react";
import { Box, Text } from "ink";
import type { ThemeTokens } from "../themes/registry.js";
import { useTerminalLayout } from "../layout/TerminalLayoutProvider.js";

export interface AtPickerProps {
  theme: ThemeTokens;
  paths: string[];
  index: number;
  query: string;
}



function fileIcon(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  switch (ext) {
    case "ts":
    case "tsx":
      return "⬡";
    case "js":
    case "jsx":
      return "◇";
    case "json":
      return "{}";
    case "md":
    case "mdx":
      return "¶";
    case "css":
    case "scss":
      return "◈";
    case "html":
      return "◻";
    case "yaml":
    case "yml":
      return "≡";
    case "toml":
    case "ini":
      return "⚙";
    case "env":
      return "⚙";
    default:
      return "·";
  }
}

export const AtPicker = memo(function AtPicker({
  theme,
  paths,
  index,
  query,
}: AtPickerProps) {
  const { composerWidth, rows } = useTerminalLayout();
  const maxVisible = rows < 22 ? 2 : rows < 26 ? 3 : rows < 30 ? 4 : 6;

  if (paths.length === 0) {
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
        <Text color={theme.muted}>No files match @{query || "…"}</Text>
        {Array.from({ length: maxVisible }).map((_, i) => (
          <Text key={i}> </Text>
        ))}
      </Box>
    );
  }

  const safe = index % paths.length;

  let start = 0;
  if (paths.length > maxVisible) {
    start = Math.max(0, Math.min(safe - 2, paths.length - maxVisible));
  }
  const visiblePaths = paths.slice(start, start + maxVisible);

  const rowsList: JSX.Element[] = [];
  for (let vi = 0; vi < maxVisible; vi++) {
    const p = visiblePaths[vi];
    if (p) {
      const realIndex = start + vi;
      const selected = realIndex === safe;
      const icon = fileIcon(p);
      rowsList.push(
        <Box key={vi} flexDirection="row" height={1} overflow="hidden">
          <Box width={3}>
            <Text color={selected ? theme.accent : theme.muted}>
              {selected ? ">" : " "}
            </Text>
          </Box>
          <Box width={4}>
            <Text color={selected ? theme.accent : theme.muted}>{icon}</Text>
          </Box>
          <Box flexGrow={1} overflow="hidden">
            <Text color={selected ? theme.accent : theme.muted}>{p}</Text>
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
        files matching @{query || "…"}
      </Text>
      {rowsList}
    </Box>
  );
});
