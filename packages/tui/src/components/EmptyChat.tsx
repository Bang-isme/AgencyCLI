import { memo } from "react";
import { Box, Text } from "ink";
import type { ThemeTokens } from "../themes/registry.js";
import { GlowingLogo } from "./GlowingLogo.js";
import { panelWidth } from "../layout/terminal-layout.js";
import { useTerminalLayout } from "../layout/TerminalLayoutProvider.js";

export interface EmptyChatProps {
  theme: ThemeTokens;
  project?: string;
  modelName?: string;
  agentMode?: string;
  indexing?: boolean;
  themeId?: string;
  noProvider?: boolean;
  height?: number;
}

export const EmptyChat = memo(function EmptyChat({
  theme,
  project = "Unknown workspace",
  modelName = "Default",
  agentMode = "agent",
  indexing = false,
  themeId = "agency",
  noProvider = false,
  height,
}: EmptyChatProps) {
  const { cols, rows: layoutRows } = useTerminalLayout();
  const rows = height ?? layoutRows;
  const panelW = panelWidth(cols);
  
  // Decide whether to use single-column or double-column layout
  const isSingleColumn = panelW < 60;
  
  // Calculate dynamic column width:
  // Inside the panel we have panelW columns.
  // Border consumes 2 columns (left and right border characters).
  // paddingX={2} consumes 4 columns (2 left, 2 right).
  // For Single Column: No divider, width = panelW - 6.
  // For Double Column: Left Column marginR={1}, Right Column marginL={1}, Vertical divider marginX={1} on each side of │ = 2 + 4 + 1 + 1 + 3 = 11 columns margins.
  // Remaining space divided by 2 = dynamic column width.
  const colW = isSingleColumn 
    ? panelW - 6 
    : Math.max(10, Math.floor((panelW - 11) / 2));

  // Adaptive label prefixes based on colW
  const projPrefix = colW >= 22 ? "• Project: " : "• Proj: ";
  const modePrefix = colW >= 20 ? "• Agent Mode: " : "• Mode: ";
  const themePrefix = colW >= 22 ? "• Active Theme: " : "• Theme: ";
  const indexPrefix = colW >= 22 ? "• Code Index: " : "• Index: ";

  // Smart truncation for project path to fit strictly in colW
  const projectSpace = colW - projPrefix.length;
  let displayProject = project;
  if (projectSpace < 6) {
    const lastSeg = project.split(/[\\/]/).pop() || project;
    displayProject = lastSeg.length > projectSpace ? lastSeg.slice(0, Math.max(1, projectSpace)) : lastSeg;
  } else if (project.length > projectSpace) {
    displayProject = "..." + project.slice(-(projectSpace - 3));
  }

  // Model name dynamic prefix and truncation to fit strictly in colW
  const modelPrefix = colW >= 20 ? "• Model: " : "• Mod: ";
  const modelSpace = colW - modelPrefix.length;
  let displayModel = modelName;
  if (modelSpace < 4) {
    const lastSeg = modelName.split("/").pop() || modelName;
    displayModel = lastSeg.length > modelSpace ? lastSeg.slice(0, Math.max(1, modelSpace)) : lastSeg;
  } else if (modelName.length > modelSpace) {
    const lastSeg = modelName.split("/").pop() || modelName;
    if (lastSeg.length > modelSpace) {
      displayModel = "..." + lastSeg.slice(-(modelSpace - 3));
    } else {
      displayModel = lastSeg;
    }
  }

  // Agent Mode truncation to fit strictly in colW
  const modeSpace = colW - modePrefix.length;
  let displayMode = agentMode.charAt(0).toUpperCase() + agentMode.slice(1);
  if (modeSpace < 4) {
    displayMode = displayMode.length > modeSpace ? displayMode.slice(0, Math.max(1, modeSpace)) : displayMode;
  } else if (displayMode.length > modeSpace) {
    displayMode = displayMode.slice(0, modeSpace - 1) + "…";
  }

  // Active Theme truncation to fit strictly in colW
  const themeSpace = colW - themePrefix.length;
  let displayTheme = themeId;
  if (themeSpace < 4) {
    displayTheme = displayTheme.length > themeSpace ? displayTheme.slice(0, Math.max(1, themeSpace)) : displayTheme;
  } else if (displayTheme.length > themeSpace) {
    displayTheme = displayTheme.slice(0, themeSpace - 1) + "…";
  }

  // Code Index status truncation to fit strictly in colW
  const indexSpace = colW - indexPrefix.length;
  let displayIndex = indexing ? "Indexing..." : "Ready ✓";
  if (displayIndex.length > indexSpace) {
    const shortStatus = indexing ? "Indexing" : "Ready";
    if (shortStatus.length > indexSpace) {
      const tinyStatus = indexing ? "Idx..." : "OK";
      if (tinyStatus.length > indexSpace) {
        displayIndex = indexing ? "…" : "✓";
      } else {
        displayIndex = tinyStatus;
      }
    } else {
      displayIndex = shortStatus;
    }
  }

  // Responsive headers based on colW
  const leftHeader = colW >= 28 ? "Quick start & slash commands" : colW >= 18 ? "Quick commands" : "Commands";
  const rightHeader = colW >= 28 ? "Workspace system context" : colW >= 18 ? "System context" : "Context";

  // Helper to pad space to guarantee fixed line width and clear trailing garbage characters
  const getPad = (label: string, value: string, targetWidth: number) => {
    const currentLen = label.length + value.length;
    if (currentLen >= targetWidth) return "";
    return " ".repeat(targetWidth - currentLen);
  };

  // Tip text based on available content width and terminal height
  const showTipBorder = colW >= 32;
  const tipPaddingX = showTipBorder ? 1 : 0;
  const tipBorderWidth = showTipBorder ? 2 : 0;
  const tipUsableW = colW - tipBorderWidth - (tipPaddingX * 2);

  let tipText = "";
  if (colW >= 22 && rows >= 20) {
    if (tipUsableW >= 48) {
      tipText = "Tip: Press ? to open help & shortcuts overlays";
    } else if (tipUsableW >= 33) {
      tipText = "Tip: Press ? for help & shortcuts";
    } else if (tipUsableW >= 21) {
      tipText = "Tip: Press ? for help";
    } else if (tipUsableW >= 16) {
      tipText = "Press ? for help";
    } else if (tipUsableW >= 7) {
      tipText = "?: Help";
    }
  }

  const COMMANDS = [
    { cmd: "/goal <task>", fullDesc: "Run autonomous multi-step loops", shortDesc: "Autonomous loop" },
    { cmd: "/models", fullDesc: "List & change active AI model providers", shortDesc: "Switch models" },
    { cmd: "/connect", fullDesc: "Manage API Keys and credentials", shortDesc: "API Keys" },
    { cmd: "/status", fullDesc: "Live telemetry & MCP servers status", shortDesc: "System status" },
    { cmd: "/sessions", fullDesc: "Switch/delete past conversations", shortDesc: "Switch session" },
  ];

  // Adjust commands display and system context lines dynamically based on rows
  let displayCommands = COMMANDS;
  if (rows < 20) {
    displayCommands = COMMANDS.slice(0, 3);
  } else if (rows < 24) {
    displayCommands = COMMANDS.slice(0, 4);
  }

  const showThemeLine = rows >= 22;
  const showIndexLine = rows >= 16;

  const showLogoSubtitle = rows >= 28 && cols >= 48;
  const dividerLines = colW >= 32 ? 6 : 5;

  return (
    <Box
      flexDirection="column"
      alignItems="center"
      justifyContent="center"
      flexGrow={1}
      paddingY={rows < 28 ? 0 : 1}
    >
      {/* Brand ASCII Logo Header */}
      <Box flexDirection="column" alignItems="center" marginBottom={rows < 28 ? 0 : 1} flexShrink={0}>
        <GlowingLogo theme={theme} maxWidth={panelW} animated={false} height={rows} />
        {showLogoSubtitle && (
          <Box marginTop={1} flexShrink={0}>
            <Text color={theme.muted}>c o m m a n d   l i n e   i n t e r f a c e</Text>
          </Box>
        )}
      </Box>

      {/* First-run nudge: no LLM provider configured yet */}
      {noProvider && (
        <Box
          width={panelW}
          marginBottom={1}
          borderStyle="round"
          borderColor={theme.warning}
          paddingX={1}
          justifyContent="center"
          flexShrink={0}
        >
          <Text color={theme.warning} bold>
            ▲ No model connected — press{" "}
            <Text color={theme.text} bold>
              /connect
            </Text>{" "}
            to add an API key
          </Text>
        </Box>
      )}

      {/* Main Two-Column or Single-Column Dashboard Panel */}
      <Box
        flexDirection={isSingleColumn ? "column" : "row"}
        width={panelW}
        overflow="hidden"
        borderStyle="round"
        borderColor={theme.dimBorder}
        paddingX={2}
        paddingY={rows < 28 ? 0 : 1}
        flexShrink={0}
      >
        {/* Left/Top Column: Quick Commands / Tips */}
        {(!isSingleColumn || rows >= 18) && (
          <Box 
            flexDirection="column" 
            width={colW} 
            marginRight={isSingleColumn ? 0 : 1} 
            marginBottom={isSingleColumn ? 1 : 0}
            overflow="hidden"
            flexShrink={0}
          >
            <Box marginBottom={1} width={colW} overflow="hidden" flexShrink={0}>
              <Text bold color={theme.accent}>
                ● {leftHeader}
                {" ".repeat(Math.max(0, colW - 3 - leftHeader.length))}
              </Text>
            </Box>
            <Box flexDirection="column" overflow="hidden" flexShrink={0}>
              {displayCommands.map((c) => {
                let desc = "";
                if (colW >= 42) {
                  desc = ` — ${c.fullDesc}`;
                } else if (colW >= 32) {
                  desc = ` — ${c.shortDesc}`;
                }
                
                let cmdDisplay = c.cmd;
                if (cmdDisplay.length > colW) {
                  cmdDisplay = cmdDisplay.slice(0, colW - 1) + "…";
                }
                
                if (desc && (cmdDisplay.length + desc.length > colW)) {
                  const descSpace = colW - cmdDisplay.length;
                  if (descSpace < 5) {
                    desc = "";
                  } else {
                    desc = desc.slice(0, descSpace - 1) + "…";
                  }
                }

                return (
                  <Box key={c.cmd} width={colW} overflow="hidden" flexShrink={0}>
                    <Text>
                      <Text color={theme.text} bold>{cmdDisplay}</Text>
                      {desc ? <Text color={theme.muted}>{desc}</Text> : null}
                      <Text>{getPad(cmdDisplay, desc, colW)}</Text>
                    </Text>
                  </Box>
                );
              })}
              
              {colW >= 18 && (
                <Box marginTop={1} width={colW} overflow="hidden" flexShrink={0}>
                  <Text color={theme.warning}>
                    {colW >= 45 ? (
                      <Text>
                        <Text bold>@</Text> files reference · <Text bold>!</Text> run sandboxed shell commands
                        <Text>{" ".repeat(Math.max(0, colW - "@ files reference · ! run sandboxed shell commands".length))}</Text>
                      </Text>
                    ) : colW >= 28 ? (
                      <Text>
                        <Text bold>@</Text> files · <Text bold>!</Text> shell commands
                        <Text>{" ".repeat(Math.max(0, colW - "@ files · ! shell commands".length))}</Text>
                      </Text>
                    ) : (
                      <Text>
                        <Text bold>@</Text> files · <Text bold>!</Text> shell
                        <Text>{" ".repeat(Math.max(0, colW - "@ files · ! shell".length))}</Text>
                      </Text>
                    )}
                  </Text>
                </Box>
              )}
            </Box>
          </Box>
        )}

        {/* Vertical divider (Only in double column) */}
        {!isSingleColumn && (
          <Box flexDirection="column" justifyContent="center" marginX={1} flexShrink={0}>
            {Array.from({ length: dividerLines }).map((_, i) => (
              <Text key={i} color={theme.dimBorder}>│</Text>
            ))}
          </Box>
        )}

        {/* Right/Bottom Column: Active System Info */}
        <Box 
          flexDirection="column" 
          width={colW} 
          marginLeft={isSingleColumn ? 0 : 1}
          marginTop={isSingleColumn && (!isSingleColumn || rows >= 18) ? 1 : 0}
          overflow="hidden"
          flexShrink={0}
        >
          <Box marginBottom={1} width={colW} overflow="hidden" flexShrink={0}>
            <Text bold color={theme.accent}>
              ● {rightHeader}
              {" ".repeat(Math.max(0, colW - 3 - rightHeader.length))}
            </Text>
          </Box>
          <Box flexDirection="column" width={colW} overflow="hidden" flexShrink={0}>
            <Box width={colW} overflow="hidden" flexShrink={0}>
              <Text>
                <Text color={theme.muted}>{projPrefix}</Text>
                <Text color={theme.text} bold>{displayProject}</Text>
                <Text>{getPad(projPrefix, displayProject, colW)}</Text>
              </Text>
            </Box>
            <Box width={colW} overflow="hidden" flexShrink={0}>
              <Text>
                <Text color={theme.muted}>{modelPrefix}</Text>
                <Text color={theme.success}>{displayModel}</Text>
                <Text>{getPad(modelPrefix, displayModel, colW)}</Text>
              </Text>
            </Box>
            <Box width={colW} overflow="hidden" flexShrink={0}>
              <Text>
                <Text color={theme.muted}>{modePrefix}</Text>
                <Text color={theme.warning} bold>{displayMode}</Text>
                <Text>{getPad(modePrefix, displayMode, colW)}</Text>
              </Text>
            </Box>
            {showThemeLine && (
              <Box width={colW} overflow="hidden" flexShrink={0}>
                <Text>
                  <Text color={theme.muted}>{themePrefix}</Text>
                  <Text color={theme.text}>{displayTheme}</Text>
                  <Text>{getPad(themePrefix, displayTheme, colW)}</Text>
                </Text>
              </Box>
            )}
            {showIndexLine && (
              <Box width={colW} overflow="hidden" flexShrink={0}>
                <Text>
                  <Text color={theme.muted}>{indexPrefix}</Text>
                  <Text color={indexing ? theme.accent : theme.success}>{displayIndex}</Text>
                  <Text>{getPad(indexPrefix, displayIndex, colW)}</Text>
                </Text>
              </Box>
            )}
          </Box>

          {tipText ? (
            <Box
              marginTop={1}
              borderStyle={showTipBorder ? "single" : undefined}
              borderColor={theme.dimBorder}
              paddingX={tipPaddingX}
              width={colW}
              overflow="hidden"
              flexShrink={0}
            >
              <Text color={theme.muted} dimColor>
                {tipText.includes("?") ? (
                  <>
                    {tipText.split("?")[0]}
                    <Text bold color={theme.text}>?</Text>
                    {tipText.split("?")[1]}
                  </>
                ) : (
                  tipText
                )}
                {" ".repeat(Math.max(0, tipUsableW - tipText.length))}
              </Text>
            </Box>
          ) : null}
        </Box>
      </Box>
    </Box>
  );
});
