import { useState, useEffect, useRef, useCallback } from "react";
import { Box, Text, useInput } from "ink";
import { readdirSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ThemeTokens } from "../themes/registry.js";
import { useTerminalLayout } from "../layout/TerminalLayoutProvider.js";
import { panelWidth } from "../layout/terminal-layout.js";

export interface PluginsOverlayProps {
  theme: ThemeTokens;
  skillsRoot: string;
  maxVisible?: number;
  onClose: () => void;
}

interface PluginItem {
  id: string;
  name: string;
  description: string;
  active: boolean;
}

function loadPlugins(skillsRoot: string): PluginItem[] {
  try {
    const dirs = readdirSync(skillsRoot, { withFileTypes: true });
    const available: PluginItem[] = [];

    let activeSkills: string[] = [];
    try {
      const manifestPath = join(skillsRoot, ".system", "manifest.json");
      if (existsSync(manifestPath)) {
        const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
        if (Array.isArray(manifest.skills)) {
          activeSkills = manifest.skills;
        }
      }
    } catch {}

    for (const d of dirs) {
      if (
        d.isDirectory() &&
        !d.name.startsWith(".") &&
        d.name !== "node_modules" &&
        d.name !== "templates" &&
        d.name !== "tests"
      ) {
        const skillMd = join(skillsRoot, d.name, "SKILL.md");
        if (existsSync(skillMd)) {
          let name = d.name;
          let description = "";
          try {
            const content = readFileSync(skillMd, "utf8");
            const titleMatch = content.match(/^name:\s*(.+)$/m);
            if (titleMatch && titleMatch[1]) {
              name = titleMatch[1].replace(/['"]/g, "").trim();
            }
            const descMatch = content.match(/^description:\s*(.+)$/m);
            if (descMatch && descMatch[1]) {
              description = descMatch[1].replace(/['"]/g, "").trim();
            }
          } catch {}

          available.push({
            id: d.name,
            name,
            description,
            active: activeSkills.includes(d.name),
          });
        }
      }
    }

    available.sort((a, b) => {
      if (a.active !== b.active) return a.active ? -1 : 1;
      return a.id.localeCompare(b.id);
    });

    return available;
  } catch {
    return [];
  }
}

function loadVersion(skillsRoot: string): string {
  try {
    const manifestPath = join(skillsRoot, ".system", "manifest.json");
    if (existsSync(manifestPath)) {
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      if (manifest.version) {
        return manifest.version;
      }
    }
  } catch {}
  return "—";
}

export function PluginsOverlay({ theme, skillsRoot, maxVisible = 10, onClose }: PluginsOverlayProps) {
  const { cols } = useTerminalLayout();
  const overlayWidth = panelWidth(cols, 80, 45);
  const innerWidth = overlayWidth - 4;
  const dividerStr = "─".repeat(Math.max(0, innerWidth));

  // Synchronous initialization prevents first-frame flicker or layout shift glitches
  const [plugins, setPlugins] = useState<PluginItem[]>(() => loadPlugins(skillsRoot));
  const [index, setIndex] = useState(0);
  const [version, setVersion] = useState(() => loadVersion(skillsRoot));

  useEffect(() => {
    const loaded = loadPlugins(skillsRoot);
    setPlugins(loaded);
    setVersion(loadVersion(skillsRoot));
    setIndex((i) => Math.min(Math.max(0, loaded.length - 1), i));
  }, [skillsRoot]);

  const safeIndex = plugins.length === 0 ? 0 : index % plugins.length;
  const activeCount = plugins.filter((p) => p.active).length;
  const selected = plugins[safeIndex];

  // Sliding window
  let start = 0;
  if (plugins.length > maxVisible) {
    start = Math.max(
      0,
      Math.min(safeIndex - Math.floor(maxVisible / 2), plugins.length - maxVisible)
    );
  }
  const visiblePlugins = plugins.slice(start, start + maxVisible);

  let descLine = "";
  if (selected?.description) {
    descLine = selected.description.trim();
  }

  const stateRef = useRef({
    plugins,
    onClose,
  });

  useEffect(() => {
    stateRef.current = {
      plugins,
      onClose,
    };
  });

  useInput(
    useCallback((input, key) => {
      const { plugins, onClose } = stateRef.current;
      if (key.escape) {
        onClose();
        return;
      }
      if (plugins.length === 0) return;
      if (key.upArrow || input === "k") {
        setIndex((i) => (i === 0 ? plugins.length - 1 : i - 1));
        return;
      }
      if (key.downArrow || input === "j") {
        setIndex((i) => (i === plugins.length - 1 ? 0 : i + 1));
        return;
      }
    }, [])
  );

  const scrollUpHint = start > 0 ? ` (▲ ${start} above)` : "";
  const scrollDownHint = start + maxVisible < plugins.length ? ` (▼ ${plugins.length - start - maxVisible} below)` : "";

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={theme.accent}
      paddingX={2}
      paddingY={0}
      width={overlayWidth}
    >
      {/* Header */}
      <Box flexDirection="row" justifyContent="space-between" marginTop={1} overflow="hidden">
        <Text color={theme.text} bold wrap="wrap">
          CodexAI Skills Pack{scrollUpHint}
        </Text>
        <Text color={theme.muted} wrap="wrap">
          v{version} · {activeCount}/{plugins.length} active
        </Text>
      </Box>
      <Text color={theme.dimBorder}>{dividerStr}</Text>

      {plugins.length === 0 ? (
        <Box marginY={1} overflow="hidden">
          <Text color={theme.muted} wrap="wrap">
            No skills found. Skills pack may not be installed.
          </Text>
        </Box>
      ) : (
        <>
          {/* Skills list — name only, 1 line per item with strict width constraints to prevent wrapping */}
          <Box flexDirection="column" marginY={0} overflow="hidden">
            {visiblePlugins.map((p, vi) => {
              const realIdx = start + vi;
              const sel = realIdx === safeIndex;
              const arrowStr = sel ? "▸  " : "   ";
              const activeStr = p.active ? "●  " : "○  ";

              return (
                <Box key={p.id} overflow="hidden">
                  <Text wrap="wrap">
                    <Text color={sel ? theme.accent : theme.muted}>
                      {arrowStr}
                    </Text>
                    <Text
                      color={p.active ? theme.success : theme.muted}
                      bold={p.active}
                    >
                      {activeStr}
                    </Text>
                    <Text
                      color={sel ? theme.text : theme.muted}
                      bold={sel}
                    >
                      {p.id}
                    </Text>
                  </Text>
                </Box>
              );
            })}
          </Box>

          {/* Detail panel for selected item: fixed height=2 with padded descLine to ensure zero layout shifting */}
          <Text color={theme.dimBorder}>{dividerStr}</Text>
          <Box flexDirection="column" width={innerWidth} overflow="hidden" marginTop={0}>
            <Text color={theme.accent} bold wrap="wrap">
              {selected ? selected.name : ""}
            </Text>
            <Text color={theme.muted} wrap="wrap">
              {descLine || "No description"}
            </Text>
          </Box>
        </>
      )}

      {/* Footer */}
      <Text color={theme.dimBorder}>{dividerStr}</Text>
      <Box flexDirection="row" justifyContent="space-between" marginBottom={1} overflow="hidden">
        <Text color={theme.muted} dimColor wrap="wrap">
          {innerWidth >= 45 ? `↑↓ navigate · Esc close${scrollDownHint}` : `↑↓:nav · Esc:close${scrollDownHint}`}
        </Text>
        {innerWidth >= 50 && (
          <Text color={theme.muted} dimColor wrap="wrap">
            Core harness — read-only
          </Text>
        )}
      </Box>
    </Box>
  );
}
