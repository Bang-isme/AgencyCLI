import { useState, useEffect, useMemo, useRef, useCallback } from "react";
import { Box, Text, useInput } from "ink";
import type { ThemeTokens } from "../themes/registry.js";
import type { ModelInfo } from "@agency/providers";
import { useTerminalLayout } from "../layout/TerminalLayoutProvider.js";
import { panelWidth } from "../layout/terminal-layout.js";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface ModelsOverlayProps {
  theme: ThemeTokens;
  models: ModelInfo[];
  currentModel?: string;
  loading?: boolean;
  onSelect: (model: ModelInfo) => void;
  onClose: () => void;
  maxVisible?: number;
}

function formatCtx(ctx?: number): string {
  if (!ctx) return "";
  if (ctx >= 1_000_000) return `${Math.round(ctx / 1_000_000)}M ctx`;
  if (ctx >= 1_000) return `${Math.round(ctx / 1_000)}K ctx`;
  return `${ctx} ctx`;
}

function getModelHistory(): Record<string, number> {
  try {
    const historyPath = join(homedir(), ".agency", "model_history.json");
    if (existsSync(historyPath)) {
      const content = readFileSync(historyPath, "utf8");
      return JSON.parse(content) || {};
    }
  } catch (e) {
    // Ignore error
  }
  return {};
}

function recordModelSelection(provider: string, modelId: string) {
  try {
    const dir = join(homedir(), ".agency");
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    const historyPath = join(dir, "model_history.json");
    const history = getModelHistory();
    const key = `${provider}/${modelId}`;
    history[key] = (history[key] || 0) + 1;
    writeFileSync(historyPath, JSON.stringify(history, null, 2));
  } catch (e) {
    // Ignore error
  }
}

export function ModelsOverlay({
  theme,
  models,
  currentModel,
  loading = false,
  onSelect,
  onClose,
  maxVisible = 10,
}: ModelsOverlayProps) {
  const { cols } = useTerminalLayout();
  const overlayWidth = panelWidth(cols, 90, 55);
  const innerWidth = overlayWidth - 4;
  const dividerStr = "─".repeat(Math.max(0, innerWidth));

  // Deduplicate models to avoid list spamming and key collisions
  const uniqueModels: ModelInfo[] = [];
  const seenModels = new Set<string>();
  for (const m of models) {
    const key = `${m.provider}-${m.id}`;
    if (!seenModels.has(key)) {
      seenModels.add(key);
      uniqueModels.push(m);
    }
  }

  const uniqueProviders = Array.from(new Set(uniqueModels.map((m) => m.provider)));
  const hasMultipleProviders = uniqueProviders.length > 1;

  const [selectedProvider, setSelectedProvider] = useState<string | null>(null);
  const [providerIndex, setProviderIndex] = useState(0);
  const [modelIndex, setModelIndex] = useState(0);
  const [history, setHistory] = useState<Record<string, number>>({});
  const [searchQuery, setSearchQuery] = useState("");

  // Load history once on mount
  useEffect(() => {
    setHistory(getModelHistory());
  }, []);

  // Clear search query when provider changes
  useEffect(() => {
    setSearchQuery("");
  }, [selectedProvider]);

  // Auto-select provider if only one exists
  useEffect(() => {
    if (uniqueModels.length > 0 && !selectedProvider) {
      const providers = Array.from(new Set(uniqueModels.map((m) => m.provider)));
      if (providers.length === 1) {
        setSelectedProvider(providers[0]!);
      }
    }
  }, [uniqueModels, selectedProvider]);

  const providers = uniqueProviders;
  const safeProviderIndex = providers.length === 0 ? 0 : providerIndex % providers.length;

  const currentProvider = selectedProvider || uniqueProviders[0];

  const filteredModels = useMemo(() => {
    const base = uniqueModels.filter((m) => m.provider === currentProvider);
    if (!searchQuery) return base;
    const q = searchQuery.toLowerCase();
    return base.filter((m) =>
      (m.id || "").toLowerCase().includes(q) ||
      (m.name || "").toLowerCase().includes(q)
    );
  }, [uniqueModels, currentProvider, searchQuery]);

  // Get frequent models for the current provider
  const frequentModels = useMemo(() => {
    if (!currentProvider || searchQuery) return [];
    return filteredModels
      .filter((m) => {
        const key = `${m.provider}/${m.id}`;
        return history[key] && history[key] > 0;
      })
      .sort((a, b) => {
        const keyA = `${a.provider}/${a.id}`;
        const keyB = `${b.provider}/${b.id}`;
        return (history[keyB] || 0) - (history[keyA] || 0);
      })
      .slice(0, 3);
  }, [filteredModels, history, currentProvider, searchQuery]);

  // Combine frequent models and filtered models
  const selectableItems = useMemo(() => {
    const items: Array<{ type: "frequent" | "all"; model: ModelInfo }> = [];
    for (const m of frequentModels) {
      items.push({ type: "frequent", model: m });
    }
    for (const m of filteredModels) {
      items.push({ type: "all", model: m });
    }
    return items;
  }, [frequentModels, filteredModels]);

  const safeModelIndex = selectableItems.length === 0 ? 0 : modelIndex % selectableItems.length;

  const stateRef = useRef({
    selectedProvider,
    providerIndex,
    modelIndex,
    history,
    models,
    onSelect,
    onClose,
    providers,
    safeProviderIndex,
    selectableItems,
    safeModelIndex,
    hasMultipleProviders,
    searchQuery,
  });

  useEffect(() => {
    stateRef.current = {
      selectedProvider,
      providerIndex,
      modelIndex,
      history,
      models,
      onSelect,
      onClose,
      providers,
      safeProviderIndex,
      selectableItems,
      safeModelIndex,
      hasMultipleProviders,
      searchQuery,
    };
  });

  useInput(
    useCallback((input, key) => {
      const {
        selectedProvider,
        onSelect,
        onClose,
        providers,
        safeProviderIndex,
        selectableItems,
        safeModelIndex,
        hasMultipleProviders,
        searchQuery,
      } = stateRef.current;
    if (key.escape) {
      if (searchQuery) {
        setSearchQuery("");
        setModelIndex(0);
        return;
      }
      if (selectedProvider && hasMultipleProviders) {
        setSelectedProvider(null);
      } else {
        onClose();
      }
      return;
    }

    if (!selectedProvider && hasMultipleProviders) {
      // Provider selection interaction
      if (key.upArrow || input === "k") {
        setProviderIndex((i) => (i === 0 ? providers.length - 1 : i - 1));
        return;
      }
      if (key.downArrow || input === "j") {
        setProviderIndex((i) => (i === providers.length - 1 ? 0 : i + 1));
        return;
      }
      if (key.return) {
        const prov = providers[safeProviderIndex];
        if (prov) {
          setSelectedProvider(prov);
          setModelIndex(0);
        }
        return;
      }
    } else {
      // Model selection interaction
      if (key.upArrow) {
        setModelIndex((i) => (i === 0 ? selectableItems.length - 1 : i - 1));
        return;
      }
      if (key.downArrow) {
        setModelIndex((i) => (i === selectableItems.length - 1 ? 0 : i + 1));
        return;
      }
      if (key.return) {
        const item = selectableItems[safeModelIndex];
        if (item) {
          recordModelSelection(item.model.provider, item.model.id);
          onSelect(item.model);
        }
        return;
      }

      // Fast Search Typing Interceptor
      if (key.backspace) {
        setSearchQuery((q) => q.slice(0, -1));
        setModelIndex(0);
        return;
      }
      const isPrintable = input.length === 1 && input.charCodeAt(0) >= 32 && input.charCodeAt(0) !== 127;
      if (isPrintable) {
        setSearchQuery((q) => q + input);
        setModelIndex(0);
        return;
      }
    }
  }, [])
  );

  if (loading) {
    return (
      <Box
        borderStyle="round"
        borderColor={theme.accent}
        paddingX={2}
        paddingY={0}
        width={overlayWidth}
      >
        <Box marginY={1}>
          <Text color={theme.accent}>Scanning available models…</Text>
        </Box>
      </Box>
    );
  }

  if (uniqueModels.length === 0) {
    return (
      <Box
        borderStyle="round"
        borderColor={theme.border}
        paddingX={2}
        paddingY={0}
        width={overlayWidth}
        flexDirection="column"
      >
        <Box marginTop={1}>
          <Text color={theme.text} bold>Select Model</Text>
        </Box>
        <Text color={theme.muted}>No models available. Use /connect to add a provider first.</Text>
        <Box marginBottom={1} marginTop={1}>
          <Text color={theme.muted} dimColor>Esc to close</Text>
        </Box>
      </Box>
    );
  }

  // Phase 1: Select Provider Screen
  if (!selectedProvider && hasMultipleProviders) {
    const provColW = Math.min(18, Math.max(12, Math.floor(innerWidth * 0.3)));
    let provFooter = "";
    if (innerWidth >= 60) {
      provFooter = "Enter to select provider · ↑↓ navigate · Esc close";
    } else if (innerWidth >= 45) {
      provFooter = "Enter select · ↑↓ nav · Esc close";
    } else {
      provFooter = "Enter:sel · ↑↓:nav · Esc:close";
    }

    return (
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor={theme.accent}
        paddingX={2}
        paddingY={0}
        width={overlayWidth}
      >
        <Box flexDirection="row" justifyContent="space-between" marginTop={1} overflow="hidden">
          <Text color={theme.text} bold wrap="wrap">Select Provider</Text>
          <Text color={theme.muted} wrap="wrap">
            ({safeProviderIndex + 1}/{providers.length})
          </Text>
        </Box>
        <Text color={theme.dimBorder}>{dividerStr}</Text>

        <Box flexDirection="column" marginY={0} overflow="hidden">
          {providers.map((p, i) => {
            const sel = i === safeProviderIndex;
            const count = uniqueModels.filter((m) => m.provider === p).length;
            const providerLabel = p.toUpperCase();

            return (
              <Box key={p} flexDirection="row" alignItems="center" height={1} overflow="hidden">
                <Box width={3}>
                  <Text color={sel ? theme.accent : theme.muted}>
                    {sel ? "▸" : " "}
                  </Text>
                </Box>
                <Box width={provColW}>
                  <Text color={sel ? theme.accent : theme.muted} bold={sel} wrap="wrap">
                    {`[${providerLabel}]`}
                  </Text>
                </Box>
                <Box flexGrow={1}>
                  <Text color={sel ? theme.text : theme.muted} wrap="wrap">
                    {`${count} model${count > 1 ? "s" : ""} available`}
                  </Text>
                </Box>
              </Box>
            );
          })}
        </Box>

        <Text color={theme.dimBorder}>{dividerStr}</Text>
        <Box marginBottom={1} overflow="hidden">
          <Text color={theme.muted} dimColor wrap="wrap">
            {provFooter}
          </Text>
        </Box>
      </Box>
    );
  }

  // Phase 2: Select Model Screen (filtered by selected provider)
  // Calculate sliding window for filtered list
  let start = 0;
  if (selectableItems.length > maxVisible) {
    start = Math.max(
      0,
      Math.min(safeModelIndex - Math.floor(maxVisible / 2), selectableItems.length - maxVisible)
    );
  }
  const visibleItems = selectableItems.slice(start, start + maxVisible);
  const providerTitle = (selectedProvider || uniqueProviders[0] || "").toUpperCase();

  const scrollUpHint = start > 0 ? (innerWidth >= 50 ? ` (▲ ${start} above)` : " ▲") : "";
  const scrollDownHint = start + maxVisible < selectableItems.length ? (innerWidth >= 50 ? ` (▼ ${selectableItems.length - start - maxVisible} below)` : " ▼") : "";

  const showContext = innerWidth >= 45;
  const showActive = innerWidth >= 36;

  let modelFooter = "";
  if (searchQuery) {
    modelFooter = `Enter to select · Backspace edit search · Esc to clear${scrollDownHint}`;
  } else if (innerWidth >= 65) {
    modelFooter = `Enter to select · ↑↓ navigate · ${hasMultipleProviders ? "Esc back to providers" : "Esc close"}${scrollDownHint}`;
  } else if (innerWidth >= 45) {
    modelFooter = `Enter select · ↑↓ nav · ${hasMultipleProviders ? "Esc back" : "Esc close"}${scrollDownHint}`;
  } else {
    modelFooter = `Enter:sel · ↑↓:nav · ${hasMultipleProviders ? "Esc:back" : "Esc:close"}${scrollDownHint}`;
  }

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={theme.accent}
      paddingX={2}
      paddingY={0}
      width={overlayWidth}
    >
      <Box flexDirection="row" justifyContent="space-between" marginTop={1} overflow="hidden">
        <Text color={theme.text} bold wrap="wrap">
          Select Model › {providerTitle}{scrollUpHint}
        </Text>
        <Text color={theme.muted} wrap="wrap">
          ({safeModelIndex + 1}/{selectableItems.length})
        </Text>
      </Box>
      <Text color={theme.dimBorder}>{dividerStr}</Text>

      {/* Premium Search Input Box */}
      <Box
        paddingX={1}
        marginY={0}
        flexDirection="row"
        width={innerWidth}
        overflow="hidden"
      >
        <Text color={theme.accent} bold>Search › </Text>
        {searchQuery ? (
          <Text color={theme.text}>{searchQuery}</Text>
        ) : (
          <Text color={theme.muted} italic>Type to filter models...</Text>
        )}
        <Text color={theme.accent} bold>|</Text>
      </Box>
      <Text color={theme.dimBorder}>{dividerStr}</Text>

      <Box flexDirection="column" marginY={0} overflow="hidden">
        {visibleItems.map((item, vi) => {
          const realIdx = start + vi;
          const { type, model: m } = item;
          const sel = realIdx === safeModelIndex;
          const isCurrent =
            m.id === currentModel ||
            `${m.provider}/${m.id}` === currentModel ||
            (currentModel?.includes("/") && currentModel.split("/").slice(1).join("/") === m.id);

          let activeText = "";
          if (isCurrent) {
            if (innerWidth >= 50) {
              activeText = "● active";
            } else if (innerWidth >= 45) {
              activeText = "● act";
            } else {
              activeText = "●";
            }
          }

          const showFrequentHeader = realIdx === 0 && type === "frequent";
          const showAllHeader = frequentModels.length > 0 && realIdx === frequentModels.length;

          return (
            <Box key={`${m.id}-${m.provider}-${type}-${realIdx}`} flexDirection="column">
              {showFrequentHeader && (
                <Box marginBottom={0} marginTop={0}>
                  <Text color={theme.accent} bold>✦ Frequently Used</Text>
                </Box>
              )}
              {showAllHeader && (
                <Box flexDirection="column" marginBottom={0} marginTop={0}>
                  <Text color={theme.dimBorder}>{dividerStr}</Text>
                  <Box>
                    <Text color={theme.accent} bold>✦ All Models</Text>
                  </Box>
                </Box>
              )}
              <Box flexDirection="row" alignItems="center" height={1} overflow="hidden">
                <Box width={3}>
                  <Text color={sel ? theme.accent : theme.muted}>
                    {sel ? "▸" : " "}
                  </Text>
                </Box>
                <Box flexGrow={1} flexShrink={1}>
                  <Text color={sel ? theme.text : (isCurrent ? theme.text : theme.muted)} bold={sel || isCurrent} wrap="wrap">
                    {m.name || m.id}
                  </Text>
                </Box>
                {showContext && m.contextWindow && (
                  <Box width={10} marginLeft={1}>
                    <Text color={theme.muted} dimColor={!sel} wrap="wrap">
                      {formatCtx(m.contextWindow)}
                    </Text>
                  </Box>
                )}
                {showActive && isCurrent && (
                  <Box width={activeText.length} marginLeft={1}>
                    <Text color={theme.success} wrap="wrap">{activeText}</Text>
                  </Box>
                )}
              </Box>
            </Box>
          );
        })}
      </Box>

      <Text color={theme.dimBorder}>{dividerStr}</Text>
      <Box marginBottom={1} overflow="hidden">
        <Text color={theme.muted} dimColor wrap="wrap">
          {modelFooter}
        </Text>
      </Box>
    </Box>
  );
}
