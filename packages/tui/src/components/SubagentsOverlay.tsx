import { useState, useEffect, useMemo, useRef, useCallback } from "react";
import { Box, Text, useInput } from "ink";
import { readdirSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ThemeTokens } from "../themes/registry.js";
import { wrapText } from "../utils/text.js";
import { useTerminalLayout } from "../layout/TerminalLayoutProvider.js";
import { panelWidth } from "../layout/terminal-layout.js";

export interface SubagentsOverlayProps {
  theme: ThemeTokens;
  project: string;
  maxVisible?: number;
  onClose: () => void;
}

interface SubagentDispatch {
  filename: string;
  timestamp: string;
  agentId: string;
  task: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  suggestedCommands: string[];
}

function loadDispatches(project: string): SubagentDispatch[] {
  try {
    const agentsPath = join(project, ".agency", "agents");
    if (!existsSync(agentsPath)) {
      return [];
    }
    const files = readdirSync(agentsPath)
      .filter((f) => f.startsWith("dispatch-") && f.endsWith(".json"))
      .sort()
      .reverse(); // Newest first

    const list: SubagentDispatch[] = [];
    // Limit to 50 items for speed
    const filesToLoad = files.slice(0, 50);

    for (const f of filesToLoad) {
      try {
        const filePath = join(agentsPath, f);
        const data = JSON.parse(readFileSync(filePath, "utf8"));
        const req = data.request ?? {};
        const res = data.result ?? {};
        
        list.push({
          filename: f,
          timestamp: data.timestamp ?? new Date().toISOString(),
          agentId: req.agentId ?? "unknown",
          task: req.task ?? "",
          exitCode: res.exitCode ?? 0,
          stdout: res.stdout ?? "",
          stderr: res.stderr ?? "",
          suggestedCommands: res.suggestedCommands ?? [],
        });
      } catch {
        // Skip malformed dispatch files
      }
    }
    return list;
  } catch {
    return [];
  }
}

export function SubagentsOverlay({
  theme,
  project,
  maxVisible = 8,
  onClose,
}: SubagentsOverlayProps) {
  const { cols, rows } = useTerminalLayout();
  const overlayWidth = panelWidth(cols, 80, 45);
  const innerWidth = overlayWidth - 4;
  const dividerStr = "─".repeat(Math.max(0, innerWidth));

  const agentIdColW = Math.min(14, Math.max(8, Math.floor(innerWidth * 0.18)));
  const statusColW = innerWidth >= 55 ? 11 : 8;
  const timeColW = innerWidth >= 65 ? 10 : 0;
  const logViewportHeight = Math.max(3, Math.min(10, rows - 16));

  const [dispatches, setDispatches] = useState<SubagentDispatch[]>(() =>
    loadDispatches(project)
  );
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [selectedDetail, setSelectedDetail] = useState<SubagentDispatch | null>(null);
  const [logScrollIndex, setLogScrollIndex] = useState(0);

  useEffect(() => {
    const loaded = loadDispatches(project);
    setDispatches(loaded);
    setSelectedIndex((i) => Math.min(Math.max(0, loaded.length - 1), i));
  }, [project]);

  const safeIndex = dispatches.length === 0 ? 0 : selectedIndex % dispatches.length;
  const currentItem = dispatches[safeIndex];

  // Sliding window for list
  let start = 0;
  if (dispatches.length > maxVisible) {
    start = Math.max(
      0,
      Math.min(safeIndex - Math.floor(maxVisible / 2), dispatches.length - maxVisible)
    );
  }
  const visibleItems = dispatches.slice(start, start + maxVisible);

  // Compute log lines if detail is selected
  const logLines = useMemo(() => {
    if (!selectedDetail) return [];
    let text = "";
    if (selectedDetail.stdout) {
      text += selectedDetail.stdout;
    }
    if (selectedDetail.stderr) {
      if (text) text += "\n";
      text += `ERROR LOG:\n${selectedDetail.stderr}`;
    }
    if (!text) {
      text = "(No logs or stdout/stderr generated)";
    }
    // We wrap log lines to fit innerWidth inside our box
    return wrapText(text, innerWidth - 2, { preserveIndent: true });
  }, [selectedDetail, innerWidth]);

  const stateRef = useRef({
    selectedDetail,
    dispatches,
    currentItem,
    logLines,
    logViewportHeight,
    onClose,
  });

  useEffect(() => {
    stateRef.current = {
      selectedDetail,
      dispatches,
      currentItem,
      logLines,
      logViewportHeight,
      onClose,
    };
  });

  useInput(
    useCallback((input, key) => {
      const { selectedDetail, dispatches, currentItem, logLines, logViewportHeight, onClose } = stateRef.current;
      if (key.escape) {
        if (selectedDetail) {
          setSelectedDetail(null);
          setLogScrollIndex(0);
        } else {
          onClose();
        }
        return;
      }

      if (selectedDetail) {
        // In log view
        if (key.upArrow || input === "k") {
          setLogScrollIndex((idx) => Math.max(0, idx - 1));
        } else if (key.downArrow || input === "j") {
          setLogScrollIndex((idx) =>
            Math.min(Math.max(0, logLines.length - logViewportHeight), idx + 1)
          );
        }
      } else {
        // In list view
        if (dispatches.length === 0) return;
        if (key.upArrow || input === "k") {
          setSelectedIndex((i) => (i === 0 ? dispatches.length - 1 : i - 1));
        } else if (key.downArrow || input === "j") {
          setSelectedIndex((i) => (i === dispatches.length - 1 ? 0 : i + 1));
        } else if (key.return) {
          setSelectedDetail(currentItem ?? null);
          setLogScrollIndex(0);
        }
      }
    }, [])
  );

  const scrollUpHint = start > 0 ? ` (▲ ${start} above)` : "";
  const scrollDownHint =
    start + maxVisible < dispatches.length
      ? ` (▼ ${dispatches.length - (start + maxVisible)} below)`
      : "";

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={theme.accent}
      paddingX={2}
      paddingY={0}
      width={overlayWidth}
    >
      {!selectedDetail ? (
        // List View
        <>
          <Box flexDirection="row" justifyContent="space-between" marginTop={1} overflow="hidden">
            <Text color={theme.accent} bold wrap="wrap">
              ● SUBAGENT RUNS HISTORY{scrollUpHint}
            </Text>
            <Text color={theme.muted} wrap="wrap">
              {dispatches.length} runs found
            </Text>
          </Box>
          <Text color={theme.dimBorder}>{dividerStr}</Text>

          {dispatches.length === 0 ? (
            <Box marginY={4} justifyContent="center" alignItems="center" overflow="hidden">
              <Text color={theme.muted} wrap="wrap">No subagent dispatches found in .agency/agents/</Text>
              <Box marginTop={1} overflow="hidden">
                <Text color={theme.muted} dimColor wrap="wrap">
                  Run a goal using <Text bold color={theme.text}>/goal</Text> to trigger parallel agent runs.
                </Text>
              </Box>
            </Box>
          ) : (
            <>
              <Box flexDirection="column" marginY={0} overflow="hidden">
                {visibleItems.map((item, vi) => {
                  const realIdx = start + vi;
                  const isSel = realIdx === safeIndex;
                  const isSuccess = item.exitCode === 0;

                  // Format timestamp
                  let timeStr = "";
                  try {
                    timeStr = new Date(item.timestamp).toLocaleTimeString();
                  } catch {
                    timeStr = item.timestamp.slice(11, 19);
                  }

                  return (
                    <Box key={item.filename} flexDirection="row" height={1} overflow="hidden">
                      <Box width={3}>
                        <Text color={isSel ? theme.accent : theme.muted}>
                          {isSel ? "▸" : " "}
                        </Text>
                      </Box>
                      <Box width={agentIdColW}>
                        <Text
                          color={isSel ? theme.text : theme.muted}
                          bold={isSel}
                          wrap="wrap"
                        >
                          {`[${item.agentId}]`}
                        </Text>
                      </Box>
                      <Box flexGrow={1} flexShrink={1} marginLeft={1}>
                        <Text color={isSel ? theme.text : theme.muted} wrap="wrap">
                          {item.task || "(no description)"}
                        </Text>
                      </Box>
                      <Box width={statusColW} marginLeft={1}>
                        <Text
                          color={isSuccess ? theme.success : theme.warning}
                          bold={isSel}
                          wrap="wrap"
                        >
                          {innerWidth >= 55 ? (isSuccess ? "✓ Done" : "✕ Error") : (isSuccess ? "✓" : "✕")}
                        </Text>
                      </Box>
                      {timeColW > 0 && (
                        <Box width={timeColW} alignItems="flex-end" marginLeft={1}>
                          <Text color={theme.muted} dimColor wrap="wrap">
                            {timeStr}
                          </Text>
                        </Box>
                      )}
                    </Box>
                  );
                })}
              </Box>
              <Text color={theme.dimBorder}>{dividerStr}</Text>
            </>
          )}

          <Box flexDirection="row" justifyContent="space-between" marginBottom={1} overflow="hidden">
            <Text color={theme.muted} dimColor wrap="wrap">
              {innerWidth >= 45 ? `↑↓ navigate · Enter view logs · Esc close${scrollDownHint}` : `↑↓:nav · Enter:logs · Esc:close${scrollDownHint}`}
            </Text>
            {innerWidth >= 60 && (
              <Text color={theme.muted} dimColor wrap="wrap">
                AgencyCLI Subagents TUX
              </Text>
            )}
          </Box>
        </>
      ) : (
        // Detail / Log View
        <>
          <Box flexDirection="row" justifyContent="space-between" marginTop={1} overflow="hidden">
            <Text color={theme.accent} bold wrap="wrap">
              ● LOGS: [{selectedDetail.agentId}]
            </Text>
            <Text
              color={selectedDetail.exitCode === 0 ? theme.success : theme.warning}
              bold
              wrap="wrap"
            >
              {selectedDetail.exitCode === 0 ? "SUCCESS" : `FAILED (${selectedDetail.exitCode})`}
            </Text>
          </Box>
          <Text color={theme.dimBorder}>{dividerStr}</Text>

          {/* Prompt / Task Box */}
          <Box flexDirection="column" marginBottom={1} overflow="hidden">
            <Text color={theme.muted} bold wrap="wrap">Task Prompt:</Text>
            <Box
              borderStyle="single"
              borderColor={theme.dimBorder}
              paddingX={1}
              flexDirection="column"
              width={innerWidth}
              overflow="hidden"
            >
              <Text color={theme.text} wrap="wrap">{selectedDetail.task}</Text>
            </Box>
          </Box>

          {/* Suggested commands */}
          {selectedDetail.suggestedCommands && selectedDetail.suggestedCommands.length > 0 && (
            <Box flexDirection="column" marginBottom={1} overflow="hidden">
              <Text color={theme.accent} bold wrap="wrap">Suggested Commands:</Text>
              {selectedDetail.suggestedCommands.map((cmd, i) => (
                <Text key={i} color={theme.success} wrap="wrap">
                  {`  $ ${cmd}`}
                </Text>
              ))}
            </Box>
          )}

          {/* Logs scroll area */}
          <Box flexDirection="column" overflow="hidden">
            <Box flexDirection="row" justifyContent="space-between" overflow="hidden">
              <Text color={theme.muted} bold wrap="wrap">Console Output:</Text>
              <Text color={theme.muted} wrap="wrap">
                {logLines.length > 0 ? logScrollIndex + 1 : 0}-
                {Math.min(logLines.length, logScrollIndex + logViewportHeight)} of {logLines.length}
              </Text>
            </Box>
            <Box
              borderStyle="single"
              borderColor={theme.dimBorder}
              paddingX={1}
              height={logViewportHeight + 2}
              flexDirection="column"
              width={innerWidth}
              overflow="hidden"
            >
              {logLines
                .slice(logScrollIndex, logScrollIndex + logViewportHeight)
                .map((line: string, idx: number) => (
                  <Text key={idx} color={theme.text} wrap="wrap">
                    {line}
                  </Text>
                ))}
              {logLines.length === 0 && (
                <Text color={theme.muted} italic wrap="wrap">No output recorded.</Text>
              )}
            </Box>
          </Box>

          <Text color={theme.dimBorder}>{dividerStr}</Text>
          <Box flexDirection="row" justifyContent="space-between" marginBottom={1} overflow="hidden">
            <Text color={theme.muted} dimColor wrap="wrap">
              ↑↓ scroll logs · Esc back to list
            </Text>
            {innerWidth >= 60 && (
              <Text color={theme.muted} dimColor wrap="wrap">
                Press Esc again to close
              </Text>
            )}
          </Box>
        </>
      )}
    </Box>
  );
}
