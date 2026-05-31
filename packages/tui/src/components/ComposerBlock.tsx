import { memo, useEffect, useState, useRef, useCallback } from "react";
import { Box, useInput } from "ink";
import type { ThemeTokens } from "../themes/registry.js";
import type { AgentMode } from "../state/agent-modes.js";
import type { SlashMenuItem } from "../presentation/slash-menu.js";
import { completeAtRef } from "../at/utils.js";
import { SlashMenu } from "./SlashMenu.js";
import { AtPicker } from "./AtPicker.js";
import { PromptComposer } from "./PromptComposer.js";
import { useTerminalLayout } from "../layout/TerminalLayoutProvider.js";

export interface ComposerBlockProps {
  theme: ThemeTokens;
  buffer: string;
  onBufferChange: (next: string) => void;
  loading: boolean;
  showHelp: boolean;
  slashQuery: string | null;
  slashSuggestions: SlashMenuItem[];
  atQuery: string | null;
  atSuggestions: string[];
  agentMode: AgentMode;
  displayModelName: string;
  budgetMode: string;
  thinkingLabel?: string;
  project?: string;
}

export function getModeBorderColor(mode: AgentMode, theme: ThemeTokens): string {
  switch (mode) {
    case "agent":
      return theme.accent;
    case "plan":
      return theme.warning;
    case "debug":
      return theme.danger;
    case "ask":
      return theme.success;
    default:
      return theme.accent;
  }
}

/**
 * Input stack (slash/@ menus + prompt). Picker index state lives here so
 * arrow-key navigation does not re-render the conversation pane above.
 */
export const ComposerBlock = memo(function ComposerBlock({
  theme,
  buffer,
  onBufferChange,
  loading,
  showHelp,
  slashQuery,
  slashSuggestions,
  atQuery,
  atSuggestions,
  agentMode,
  displayModelName,
  budgetMode,
  thinkingLabel,
  project,
}: ComposerBlockProps) {
  const [slashIndex, setSlashIndex] = useState(0);
  const [atIndex, setAtIndex] = useState(0);

  const slashOpen = slashQuery !== null && slashSuggestions.length > 0 && !showHelp;
  const atOpen = atQuery !== null && atSuggestions.length > 0 && !showHelp;

  useEffect(() => {
    setSlashIndex(0);
  }, [slashQuery]);

  useEffect(() => {
    setSlashIndex((i) =>
      Math.min(i, Math.max(0, slashSuggestions.length - 1))
    );
  }, [slashSuggestions.length]);

  useEffect(() => {
    setAtIndex(0);
  }, [atQuery]);

  useEffect(() => {
    setAtIndex((i) => Math.min(i, Math.max(0, atSuggestions.length - 1)));
  }, [atSuggestions.length]);

  const stateRef = useRef({
    loading,
    showHelp,
    slashOpen,
    slashSuggestions,
    slashIndex,
    onBufferChange,
    atOpen,
    atSuggestions,
    atIndex,
    buffer,
  });

  useEffect(() => {
    stateRef.current = {
      loading,
      showHelp,
      slashOpen,
      slashSuggestions,
      slashIndex,
      onBufferChange,
      atOpen,
      atSuggestions,
      atIndex,
      buffer,
    };
  });

  useInput(
    useCallback((input, key) => {
      const {
        loading,
        showHelp,
        slashOpen,
        slashSuggestions,
        slashIndex,
        onBufferChange,
        atOpen,
        atSuggestions,
        atIndex,
        buffer,
      } = stateRef.current;

      if (loading || showHelp) return;

      if (slashOpen) {
        if (key.tab || input === "\t") {
          const pick = slashSuggestions[slashIndex];
          if (pick) onBufferChange(`/${pick.name}`);
          return;
        }
        if (key.upArrow) {
          setSlashIndex((i) => Math.max(0, i - 1));
          return;
        }
        if (key.downArrow) {
          setSlashIndex((i) =>
            Math.min(slashSuggestions.length - 1, i + 1)
          );
          return;
        }
      }

      if (atOpen) {
        if (key.tab || input === "\t") {
          const pick = atSuggestions[atIndex];
          if (pick) onBufferChange(completeAtRef(buffer, pick));
          return;
        }
        if (key.upArrow) {
          setAtIndex((i) => Math.max(0, i - 1));
          return;
        }
        if (key.downArrow) {
          setAtIndex((i) => Math.min(atSuggestions.length - 1, i + 1));
          return;
        }
      }
    }, [])
  );

  const { composerWidth } = useTerminalLayout();
  const isFocused = !loading && !showHelp;
  const modeColor = getModeBorderColor(agentMode, theme);
  const anchorBorderColor = isFocused ? modeColor : theme.dimBorder;

  return (
    <Box flexDirection="column" width={composerWidth} overflow="hidden">
      {slashOpen ? (
        <Box marginBottom={1}>
          <SlashMenu
            theme={theme}
            items={slashSuggestions}
            index={slashIndex}
            visible
          />
        </Box>
      ) : null}
      {atOpen ? (
        <Box marginBottom={1}>
          <AtPicker
            theme={theme}
            paths={atSuggestions}
            index={atIndex}
            query={atQuery ?? ""}
          />
        </Box>
      ) : null}

      <Box
        borderStyle="single"
        borderColor={anchorBorderColor}
        width={composerWidth}
        flexDirection="column"
        paddingX={1}
        overflow="hidden"
      >
        <PromptComposer
          theme={theme}
          value={buffer}
          disabled={loading}
          focused={isFocused}
          noBorder
          agentMode={agentMode}
          modelName={displayModelName}
          budgetMode={budgetMode}
          thinkingLabel={thinkingLabel}
          project={project}
        />
      </Box>
    </Box>
  );
});
