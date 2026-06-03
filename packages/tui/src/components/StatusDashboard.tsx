import { useRef, useEffect, useCallback } from "react";
import { Box, Text, useInput } from "ink";
import type { ThemeTokens } from "../themes/registry.js";
import type { ProviderStatus } from "./ConnectOverlay.js";
import type { McpServerStatus } from "@agency/core";
import { getModelSpec } from "@agency/providers";
import { getSpecSourceColor } from "../utils/spec-source.js";

import { useTerminalLayout } from "../layout/TerminalLayoutProvider.js";
import { panelWidth } from "../layout/terminal-layout.js";

export interface StatusDashboardProps {
  theme: ThemeTokens;
  providers: ProviderStatus[];
  skillsPath?: string;
  skillsCount?: number;
  mcpServers?: McpServerStatus[];
  routingWeightsCount?: number;
  sessionId?: string;
  messageCount?: number;
  contextPercent?: number;
  contextTokens?: number;
  contextMax?: number;
  currentModel?: string;
  agentMode?: string;
  lastUsage?: any;
  onClose: () => void;
}

export function StatusDashboard({
  theme,
  providers,
  skillsPath,
  skillsCount,
  mcpServers = [],
  routingWeightsCount,
  sessionId,
  messageCount = 0,
  contextPercent = 0,
  contextTokens,
  contextMax,
  currentModel,
  agentMode,
  lastUsage,
  onClose,
}: StatusDashboardProps) {
  const { cols } = useTerminalLayout();
  const overlayWidth = panelWidth(cols, 85, 45);
  const innerWidth = overlayWidth - 4;
  const isSmallScreen = cols < 75;
  const col1Width = isSmallScreen ? innerWidth : Math.floor(innerWidth * 0.35);
  const col2Width = isSmallScreen ? innerWidth : Math.floor(innerWidth * 0.35);
  const col3Width = isSmallScreen ? innerWidth : innerWidth - col1Width - col2Width;

  const stateRef = useRef({
    onClose,
  });

  useEffect(() => {
    stateRef.current = {
      onClose,
    };
  });

  useInput(
    useCallback((_input, key) => {
      const { onClose } = stateRef.current;
      if (key.escape) {
        onClose();
        return;
      }
    }, [])
  );

  const ctxColor =
    contextPercent > 80
      ? theme.danger
      : contextPercent > 50
        ? theme.warning
        : theme.success;

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={theme.accent}
      paddingX={2}
      paddingY={1}
      width={overlayWidth}
    >
      <Text color={theme.text} bold>
        System Status
      </Text>

      <Box flexDirection={isSmallScreen ? "column" : "row"} marginTop={1}>
        {/* Column 1: Providers & Settings */}
        <Box flexDirection="column" width={col1Width} overflow="hidden">
          <Text color={theme.muted} bold dimColor>
            Providers
          </Text>
          {providers.map((p) => (
            <Text key={p.id} wrap="wrap">
              <Text color={p.configured ? theme.success : theme.danger}>
                {p.configured ? "■ " : "□ "}
              </Text>
              <Text color={theme.text}>{p.label}</Text>
            </Text>
          ))}

          <Box marginTop={1} flexDirection="column">
            <Text color={theme.muted} bold dimColor>
              Skills & Routing
            </Text>
            <Text wrap="wrap">
              <Text color={skillsPath ? theme.success : theme.danger}>
                {skillsPath ? "■ " : "□ "}
              </Text>
              <Text color={theme.text}>CodexAI Skills {skillsCount ? `(${skillsCount})` : ""}</Text>
            </Text>
            <Text wrap="wrap">
              <Text color={routingWeightsCount ? theme.success : theme.muted}>
                {routingWeightsCount ? "■ " : "□ "}
              </Text>
              <Text color={theme.text}>Routing Weights</Text>
            </Text>
          </Box>
        </Box>

        {/* Column 2: MCP Servers */}
        <Box flexDirection="column" width={col2Width} overflow="hidden" paddingX={isSmallScreen ? 0 : 1} marginTop={isSmallScreen ? 1 : 0}>
          <Text color={theme.muted} bold dimColor>
            MCP Servers
          </Text>
          {mcpServers.length > 0 ? (
            <>
              {mcpServers.map((server) => (
                <Text key={server.name} wrap="wrap">
                  <Text color={server.configured ? theme.success : theme.danger}>
                    {server.configured ? "■ " : "□ "}
                  </Text>
                  <Text color={theme.text}>{server.name}</Text>
                </Text>
              ))}
            </>
          ) : (
            <Text color={theme.muted} italic wrap="wrap">
              No servers loaded
            </Text>
          )}
        </Box>

        {/* Column 3: Session & Context */}
        <Box flexDirection="column" width={col3Width} overflow="hidden" marginTop={isSmallScreen ? 1 : 0}>
          <Text color={theme.muted} bold dimColor>
            Session
          </Text>
          {sessionId && (
            <Text color={theme.muted} wrap="wrap">
              ID: <Text color={theme.text}>{sessionId}</Text>
            </Text>
          )}
          {currentModel && (
            <Text color={theme.muted} wrap="wrap">
              Model: <Text color={theme.accent}>{currentModel.split("/").pop()}</Text>
            </Text>
          )}
          {currentModel && (() => {
            const spec = getModelSpec(currentModel.split("/").slice(1).join("/") || currentModel);
            const specSource = spec.specSource || "default";
            const specSourceLabel = specSource;
            const specSourceColor = getSpecSourceColor(specSource, theme);
            return (
              <Text color={theme.muted} wrap="wrap">
                Specs: <Text color={specSourceColor} bold>{specSourceLabel}</Text>
              </Text>
            );
          })()}
          {agentMode && (
            <Text color={theme.muted} wrap="wrap">
              Mode: <Text color={theme.text}>{agentMode}</Text>
            </Text>
          )}
          <Text color={theme.muted} wrap="wrap">
            Messages: <Text color={theme.text}>{messageCount}</Text>
          </Text>
          <Text color={theme.muted} wrap="wrap">
            Context: <Text color={ctxColor}>{contextPercent}%</Text>
          </Text>
          {contextTokens !== undefined && contextMax !== undefined && (
            <Text color={theme.muted} dimColor wrap="wrap">
              {contextTokens} / {contextMax}
            </Text>
          )}
          {lastUsage && (
            <Box flexDirection="column" marginTop={1}>
              <Text color={theme.muted} bold dimColor>
                Last Execution
              </Text>
              {lastUsage.thinkingBudget !== undefined && lastUsage.thinkingBudget !== 0 && (
                <Text color={theme.muted} wrap="wrap">
                  Budget: <Text color={theme.accent}>{typeof lastUsage.thinkingBudget === "number" ? `${lastUsage.thinkingBudget} tokens` : lastUsage.thinkingBudget}{lastUsage.taskIntent ? ` (${lastUsage.taskIntent})` : ""}</Text>
                </Text>
              )}
              <Text color={theme.muted} wrap="wrap">
                Tokens: <Text color={theme.text}>
                  {lastUsage.promptTokens?.toLocaleString("en-US") ?? 0} prompt + {lastUsage.completionTokens?.toLocaleString("en-US") ?? 0} completion
                  {lastUsage.reasoningTokens ? ` (${lastUsage.reasoningTokens.toLocaleString("en-US")} reasoning)` : ""}
                </Text>
              </Text>
            </Box>
          )}
        </Box>
      </Box>

      <Box marginTop={1}>
        <Text color={theme.muted} dimColor>
          Esc to close
        </Text>
      </Box>
    </Box>
  );
}
