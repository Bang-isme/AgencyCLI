import { useState } from "react";
import { Box, Text, useInput } from "ink";
import type { ThemeTokens } from "../themes/registry.js";
import type { ThinkingVariant, ModelSpec } from "@agency/providers";
import { useTerminalLayout } from "../layout/TerminalLayoutProvider.js";
import { panelWidth } from "../layout/terminal-layout.js";
import { getSpecSourceColor } from "../utils/spec-source.js";

export interface VariantOverlayProps {
  theme: ThemeTokens;
  modelName: string;
  providerId: string;
  modelSpec: ModelSpec;
  variants: ThinkingVariant[];
  currentThinking: string | number | undefined;
  onSelect: (value: string | number, name: string) => void;
  onClose: () => void;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}K`;
  return String(n);
}

export function VariantOverlay({
  theme,
  modelName,
  providerId,
  modelSpec,
  variants,
  currentThinking,
  onSelect,
  onClose,
}: VariantOverlayProps) {
  const { cols } = useTerminalLayout();
  const overlayWidth = panelWidth(cols, 72, 40);
  const innerWidth = overlayWidth - 4;
  const dividerStr = "─".repeat(Math.max(0, innerWidth));

  const [index, setIndex] = useState(() => {
    // Pre-select the currently active variant
    if (currentThinking === undefined) return 0;
    const idx = variants.findIndex((v) => {
      if (typeof currentThinking === "number") return v.value === currentThinking;
      return v.name === currentThinking || v.value === currentThinking;
    });
    return idx >= 0 ? idx : 0;
  });

  const safe = variants.length === 0 ? 0 : index % variants.length;

  useInput((_input, key) => {
    if (key.escape) {
      onClose();
      return;
    }
    if (key.upArrow || _input === "k") {
      setIndex((i) => (i === 0 ? variants.length - 1 : i - 1));
      return;
    }
    if (key.downArrow || _input === "j") {
      setIndex((i) => (i === variants.length - 1 ? 0 : i + 1));
      return;
    }
    if (key.return) {
      const item = variants[safe];
      if (item) onSelect(item.value, item.name);
    }
  });

  if (variants.length === 0) {
    return (
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor={theme.border}
        paddingX={2}
        paddingY={1}
        width={overlayWidth}
      >
        <Text color={theme.text} bold>Execution Variant</Text>
        <Text color={theme.muted}>
          Model "{modelName}" accepts no variant configuration.
        </Text>
        <Box marginTop={1}>
          <Text color={theme.muted} dimColor>Esc to close</Text>
        </Box>
      </Box>
    );
  }

  // Resolve display label for current thinking value
  const currentLabel = (() => {
    if (currentThinking === undefined) return "not set";
    const match = variants.find((v) => v.value === currentThinking || v.name === currentThinking);
    if (match) return match.name;
    if (typeof currentThinking === "number") return `custom (${formatTokens(currentThinking)})`;
    return String(currentThinking);
  })();

  const showDetailHeader = innerWidth >= 50;

  let footerHint = "";
  if (innerWidth >= 65) {
    footerHint = "Enter to select · ↑↓ navigate · Esc close · /variant <number> custom";
  } else if (innerWidth >= 45) {
    footerHint = "Enter select · ↑↓ nav · Esc close · /variant <num>";
  } else {
    footerHint = "Enter:sel · ↑↓:nav · Esc:close · /variant";
  }

  const specSource = modelSpec.specSource || "default";
  const specSourceLabel = specSource.toUpperCase();
  const sourceColor = getSpecSourceColor(specSource, theme);

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={theme.accent}
      paddingX={2}
      paddingY={0}
      width={overlayWidth}
    >
      {/* Header info */}
      <Box flexDirection="column" marginTop={1} overflow="hidden">
        <Text color={theme.text} bold wrap="wrap">Execution Variant</Text>
        <Text color={theme.dimBorder}>{dividerStr}</Text>
        {showDetailHeader ? (
          <Box flexDirection="column" overflow="hidden">
            <Box flexDirection="row" gap={1} overflow="hidden">
              <Text color={theme.muted} wrap="wrap">Provider:</Text>
              <Text color={theme.text} wrap="wrap">{providerId}</Text>
              <Text color={theme.muted}> · </Text>
              <Text color={theme.muted} wrap="wrap">Model:</Text>
              <Text color={theme.text} wrap="wrap">{modelName}</Text>
            </Box>
            <Box flexDirection="row" gap={1} overflow="hidden">
              <Text color={theme.muted} wrap="wrap">Max Output:</Text>
              <Text color={theme.text} wrap="wrap">~{formatTokens(modelSpec.maxOutputTokens)} tokens</Text>
              <Text color={theme.muted}> · </Text>
              <Text color={theme.muted} wrap="wrap">Context:</Text>
              <Text color={theme.text} wrap="wrap">~{formatTokens(modelSpec.contextWindow)} tokens</Text>
            </Box>
            <Box flexDirection="row" gap={1} overflow="hidden">
              <Text color={theme.muted} wrap="wrap">Current:</Text>
              <Text color={theme.accent} bold wrap="wrap">{currentLabel}</Text>
              <Text color={theme.muted}> · </Text>
              <Text color={theme.muted} wrap="wrap">Source:</Text>
              <Text color={sourceColor} bold wrap="wrap">{specSourceLabel}</Text>
            </Box>
          </Box>
        ) : (
          <Box flexDirection="column" overflow="hidden">
            <Box flexDirection="row" overflow="hidden">
              <Text color={theme.muted} wrap="wrap">Model: </Text>
              <Text color={theme.text} wrap="wrap">{modelName}</Text>
            </Box>
            <Box flexDirection="row" overflow="hidden" gap={1}>
              <Text color={theme.muted} wrap="wrap">Current: </Text>
              <Text color={theme.accent} bold wrap="wrap">{currentLabel}</Text>
              <Text color={theme.muted}>·</Text>
              <Text color={sourceColor} bold wrap="wrap">{specSourceLabel}</Text>
            </Box>
          </Box>
        )}
      </Box>

      <Text color={theme.dimBorder}>{dividerStr}</Text>

      {/* Variant list */}
      <Box flexDirection="column" marginY={0} overflow="hidden">
        {variants.map((variant, i) => {
          const sel = i === safe;
          const isActive =
            variant.value === currentThinking ||
            variant.name === currentThinking;

          let activeText = "";
          if (isActive) {
            if (innerWidth >= 45) {
              activeText = "● active";
            } else if (innerWidth >= 40) {
              activeText = "● act";
            } else {
              activeText = "●";
            }
          }

          return (
            <Box key={variant.name} flexDirection="row" alignItems="center" height={1} overflow="hidden">
              <Box width={3}>
                <Text color={sel ? theme.accent : theme.muted}>
                  {sel ? "▸" : " "}
                </Text>
              </Box>
              <Box width={10}>
                <Text color={sel ? theme.text : theme.muted} bold={sel} wrap="wrap">
                  {variant.name}
                </Text>
              </Box>
              <Box flexGrow={1} flexShrink={1}>
                <Text color={sel ? theme.text : theme.muted} dimColor={!sel} wrap="wrap">
                  {variant.desc}
                </Text>
              </Box>
              {isActive && (
                <Box width={activeText.length} marginLeft={1}>
                  <Text color={theme.success} wrap="wrap">{activeText}</Text>
                </Box>
              )}
            </Box>
          );
        })}
      </Box>

      <Text color={theme.dimBorder}>{dividerStr}</Text>
      <Box marginBottom={1} overflow="hidden">
        <Text color={theme.muted} dimColor wrap="wrap">
          {footerHint}
        </Text>
      </Box>
    </Box>
  );
}
