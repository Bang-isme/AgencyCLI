import { memo } from "react";
import { Box, Text } from "ink";
import type { ThemeTokens } from "../themes/registry.js";
import { useTerminalLayout } from "../layout/TerminalLayoutProvider.js";
import { useDisclosure } from "../state/DisclosureProvider.js";

export type PatchAction = "modify" | "add" | "remove" | "rename";

export interface PatchSymbol {
  /** Action type */
  action: PatchAction;
  /** Affected symbol or description (e.g. "AuthService.login()") */
  symbol: string;
  /** File path (tertiary visibility) */
  file?: string;
}

export interface PatchCardProps {
  theme: ThemeTokens;
  /** Overall patch title (e.g. "Applying 3 changes") */
  title?: string;
  /** Semantic symbol-level changes */
  changes: PatchSymbol[];
  /** Number of formatting-only/trivial changes hidden */
  hiddenCount?: number;
  /** Raw unified diff (shown only on expand) */
  rawDiff?: string;
  /** Whether the patch group passed validation */
  validated?: boolean;
  /** Whether rollback is available for this patch group */
  rollbackReady?: boolean;
}

const ACTION_PREFIX: Record<PatchAction, string> = {
  modify: "modify",
  add: "add",
  remove: "remove",
  rename: "rename",
};

function actionColor(theme: ThemeTokens, action: PatchAction): string {
  switch (action) {
    case "modify":
      return theme.warning;
    case "add":
      return theme.success;
    case "remove":
      return theme.danger;
    case "rename":
      return theme.accent;
  }
}

/**
 * Semantic patch card.
 *
 * DEFAULT: symbol-grouped summary with affected systems.
 * EXPAND (advanced/expert): raw unified diff visible.
 *
 * Hides formatting-only edits and import reorder noise by default.
 * Example:
 *   modify AuthService.login()
 *   add JWT refresh middleware
 *   [+12 formatting-only changes hidden]
 */
export const PatchCard = memo(function PatchCard({
  theme,
  title,
  changes,
  hiddenCount = 0,
  rawDiff,
  validated,
  rollbackReady,
}: PatchCardProps) {
  const { composerWidth } = useTerminalLayout();
  const { level } = useDisclosure();
  const diffExpanded = level === "expert";

  const showRawDiff = diffExpanded && rawDiff;
  const displayTitle = title ?? `Applying ${changes.length} change${changes.length !== 1 ? "s" : ""}`;

  return (
    <Box
      flexDirection="column"
      borderStyle="single"
      borderColor={theme.border}
      paddingX={1}
      width={Math.min(composerWidth, composerWidth - 2)}
      overflow="hidden"
      marginY={0}
    >
      {/* Header */}
      <Box flexDirection="row" justifyContent="space-between">
        <Text color={theme.text} bold>
          {displayTitle}
        </Text>
        <Box flexDirection="row">
          {validated !== undefined ? (
            <Text color={validated ? theme.success : theme.danger}>
              {validated ? "■ validated" : "□ failed"}
            </Text>
          ) : null}
          {rollbackReady ? (
            <>
              {validated !== undefined ? <Text color={theme.dimBorder}> · </Text> : null}
              <Text color={theme.muted} dimColor>rollback ready</Text>
            </>
          ) : null}
        </Box>
      </Box>

      {/* Symbol-level change summary */}
      <Box flexDirection="column" marginTop={0}>
        {changes.map((change, i) => (
          <Box key={i} flexDirection="row" overflow="hidden">
            <Text color={actionColor(theme, change.action)} bold>
              {ACTION_PREFIX[change.action]}
            </Text>
            <Text color={theme.text}> {change.symbol}</Text>
            {change.file && level !== "default" ? (
              <Text color={theme.muted} dimColor>
                {"  "}{change.file}
              </Text>
            ) : null}
          </Box>
        ))}
      </Box>

      {/* Hidden trivial changes */}
      {hiddenCount > 0 ? (
        <Box marginTop={0}>
          <Text color={theme.muted} dimColor>
            [+{hiddenCount} formatting-only change{hiddenCount > 1 ? "s" : ""} hidden]
          </Text>
        </Box>
      ) : null}

      {/* Raw diff (expert mode or toggled) */}
      {showRawDiff ? (
        <Box flexDirection="column" marginTop={0}>
          <Text color={theme.dimBorder}>{"─".repeat(Math.min(40, composerWidth - 6))}</Text>
          <Text color={theme.muted} dimColor wrap="truncate">
            {rawDiff}
          </Text>
        </Box>
      ) : rawDiff && level !== "default" && !diffExpanded ? (
        <Box marginTop={0}>
          <Text color={theme.muted} dimColor>
            ctrl+d to show raw diff
          </Text>
        </Box>
      ) : null}
    </Box>
  );
});
