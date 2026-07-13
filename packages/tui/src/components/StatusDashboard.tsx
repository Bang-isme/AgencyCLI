import { useRef, useEffect, useCallback, useState } from "react";
import { Box, Text, useInput } from "ink";
import type { ThemeTokens } from "../themes/registry.js";
import type { ProviderStatus } from "./ConnectOverlay.js";
import { getWorkspaceReadiness, type McpServerStatus, type WorkspaceReadinessCheck } from "@agency/core";
import { getModelSpec, getBaselineModelSpec, clearModelOverrideField } from "@agency/providers";
import type { ContextBreakdown } from "@agency/core";
import { getSpecSourceColor } from "../utils/spec-source.js";
import { ContextUsagePanel } from "./ContextUsagePanel.js";

import { useTerminalLayout } from "../layout/TerminalLayoutProvider.js";
import { panelWidth } from "../layout/terminal-layout.js";

export interface StatusDashboardProps {
  theme: ThemeTokens;
  project?: string;
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
  contextBreakdown?: ContextBreakdown;
  currentModel?: string;
  agentMode?: string;
  lastUsage?: any;
  onClose: () => void;
  onConfigChanged?: () => void;
}

export function StatusDashboard({
  theme,
  project = process.cwd(),
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
  contextBreakdown,
  currentModel,
  agentMode,
  lastUsage,
  onClose,
  onConfigChanged,
}: StatusDashboardProps) {
  const [readiness, setReadiness] = useState<WorkspaceReadinessCheck[]>([]);
  const { cols } = useTerminalLayout();
  const overlayWidth = panelWidth(cols, 85, 45);
  const innerWidth = overlayWidth - 6;
  const isSmallScreen = cols < 75;
  const col1Width = isSmallScreen ? innerWidth : Math.floor(innerWidth * 0.35);
  const col2Width = isSmallScreen ? innerWidth : Math.floor(innerWidth * 0.35);
  const col3Width = isSmallScreen ? innerWidth : innerWidth - col1Width - col2Width;

  const stateRef = useRef({
    onClose,
    onConfigChanged,
    currentModel,
  });

  useEffect(() => {
    stateRef.current = {
      onClose,
      onConfigChanged,
      currentModel,
    };
  });

  useEffect(() => {
    let live = true;
    void getWorkspaceReadiness(project).then((checks) => {
      if (live) setReadiness(checks);
    });
    return () => { live = false; };
  }, [project]);

  useInput(
    useCallback((input, key) => {
      const { onClose, onConfigChanged, currentModel: model } = stateRef.current;
      if (key.escape) {
        onClose();
        return;
      }
      if ((input === "r" || input === "R") && model) {
        const bare = model.split("/").slice(1).join("/") || model;
        const spec = getModelSpec(bare);
        if (spec.specSource === "override") {
          clearModelOverrideField(bare, "contextWindow");
          onConfigChanged?.();
        }
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
      {readiness.length > 0 ? (
        <Box flexDirection="column" marginTop={1}>
          <Text color={theme.muted} bold dimColor>Workspace readiness</Text>
          <Text color={theme.muted} wrap="truncate">
            {readiness.map((check) => `${check.state === "ready" ? "✓" : check.state === "attention" ? "!" : "○"} ${check.label}: ${check.detail}`).join(" · ")}
          </Text>
          {readiness.find((check) => check.state === "attention")?.recovery ? (
            <Text color={theme.warning} wrap="truncate">
              {readiness.find((check) => check.state === "attention")!.recovery}
            </Text>
          ) : null}
        </Box>
      ) : null}

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
            Model Info
          </Text>
          {currentModel && (
            <Text color={theme.muted} wrap="wrap">
              Model: <Text color={theme.accent}>{currentModel.split("/").pop()}</Text>
            </Text>
          )}
          {currentModel && (() => {
            const bare = currentModel.split("/").slice(1).join("/") || currentModel;
            const spec = getModelSpec(bare);
            const baseline = getBaselineModelSpec(bare);
            const specSource = spec.specSource || "default";
            const specSourceLabel = specSource === "override" ? "override (stale?)" : specSource;
            const specSourceColor = getSpecSourceColor(specSource, theme);
            const catalogWindow = baseline.contextWindow;
            return (
              <>
                <Text color={theme.muted} wrap="wrap">
                  Specs: <Text color={specSourceColor} bold>{specSourceLabel}</Text>
                </Text>
                {specSource === "override" && spec.contextWindow !== catalogWindow ? (
                  <Text color={theme.warning} wrap="wrap">
                    Ctx Window Override: {spec.contextWindow.toLocaleString("en-US")} (vs catalog: {catalogWindow.toLocaleString("en-US")})
                  </Text>
                ) : null}
              </>
            );
          })()}
          {agentMode && (
            <Text color={theme.muted} wrap="wrap">
              Mode: <Text color={theme.text}>{agentMode}</Text>
            </Text>
          )}

          <Box flexDirection="column" marginTop={1}>
            <Text color={theme.muted} bold dimColor>
              Session Context
            </Text>
            {sessionId && (
              <Text color={theme.muted} wrap="wrap">
                Session ID: <Text color={theme.text}>{sessionId}</Text>
              </Text>
            )}
            <Text color={theme.muted} wrap="wrap">
              Messages: <Text color={theme.text}>{messageCount}</Text>
            </Text>
            <Text color={theme.muted} wrap="wrap">
              Context Usage: <Text color={ctxColor}>{contextPercent}%</Text>
            </Text>
            {contextTokens !== undefined && contextMax !== undefined && (
              <Text color={theme.muted} dimColor wrap="wrap">
                Tokens: {contextTokens.toLocaleString("en-US")} / {contextMax.toLocaleString("en-US")}
              </Text>
            )}
          </Box>

          {lastUsage && (
            <Box flexDirection="column" marginTop={1}>
              <Text color={theme.muted} bold dimColor>
                Last Execution
              </Text>
              {lastUsage.thinkingBudget !== undefined && lastUsage.thinkingBudget !== 0 && (
                <Text color={theme.muted} wrap="wrap">
                  Budget: <Text color={theme.accent}>{typeof lastUsage.thinkingBudget === "number" ? `${lastUsage.thinkingBudget.toLocaleString("en-US")} tokens` : lastUsage.thinkingBudget}</Text>
                </Text>
              )}
              {lastUsage.taskIntent && (
                <Text color={theme.muted} wrap="wrap">
                  Intent: <Text color={theme.highlight}>{lastUsage.taskIntent}</Text>
                </Text>
              )}
              <Box flexDirection="column" marginTop={0}>
                <Text color={theme.muted}>Tokens:</Text>
                <Text>
                  {"  "}• Prompt: <Text color={theme.highlight}>{lastUsage.promptTokens?.toLocaleString("en-US") ?? 0}</Text>
                </Text>
                <Text>
                  {"  "}• Completion: <Text color={theme.success}>{lastUsage.completionTokens?.toLocaleString("en-US") ?? 0}</Text>
                </Text>
                {lastUsage.reasoningTokens ? (
                  <Text>
                    {"  "}• Reasoning: <Text color={theme.accent}>{lastUsage.reasoningTokens.toLocaleString("en-US")}</Text>
                  </Text>
                ) : null}
              </Box>
            </Box>
          )}
        </Box>
      </Box>

      {contextBreakdown ? (
        <ContextUsagePanel theme={theme} breakdown={contextBreakdown} width={innerWidth} />
      ) : null}

      <Box marginTop={1}>
        <Text color={theme.muted} dimColor>
          Esc to close · r reset stale context override
        </Text>
      </Box>
    </Box>
  );
}
