import React, { useRef, useEffect, useCallback } from "react";
import { Box, Text, useInput } from "ink";
import type { ThemeTokens } from "../themes/registry.js";
import type { ProjectEntry } from "../sessions/projects.js";
import { getStringWidth } from "../utils/text.js";
import { GlowingLogo } from "./GlowingLogo.js";

function padEndWide(str: string, targetLength: number): string {
  const width = getStringWidth(str);
  if (width >= targetLength) return str;
  return str + " ".repeat(targetLength - width);
}

export interface WelcomeScreenProps {
  theme: ThemeTokens;
  projects: ProjectEntry[];
  index: number;
  setIndex: React.Dispatch<React.SetStateAction<number>>;
  cwd: string;
  cwdIsProject: boolean;
  onSelect: (project: ProjectEntry) => void;
  onUseCwd: () => void;
  onClose: () => void;
}

export function WelcomeScreen({
  theme,
  projects,
  index,
  setIndex,
  cwd,
  cwdIsProject,
  onSelect,
  onUseCwd,
  onClose,
}: WelcomeScreenProps) {
  // Items: projects + "use cwd" option
  const totalItems = projects.length + (cwdIsProject ? 1 : 0);
  const safe = totalItems > 0 ? Math.min(index, totalItems - 1) : 0;

  const stateRef = useRef({
    totalItems,
    safe,
    projects,
    onClose,
    onUseCwd,
    onSelect,
  });

  useEffect(() => {
    stateRef.current = {
      totalItems,
      safe,
      projects,
      onClose,
      onUseCwd,
      onSelect,
    };
  });

  useInput(
    useCallback((input, key) => {
      const { totalItems, safe, projects, onClose, onUseCwd, onSelect } = stateRef.current;
      if (key.escape) {
        onClose();
        return;
      }
      if (key.upArrow || input === "k") {
        setIndex((i) => (i === 0 ? totalItems - 1 : i - 1));
        return;
      }
      if (key.downArrow || input === "j") {
        setIndex((i) => (i === totalItems - 1 ? 0 : i + 1));
        return;
      }
      if (key.return) {
        if (safe === projects.length) {
          onUseCwd();
        } else {
          const p = projects[safe];
          if (p) onSelect(p);
        }
      }
    }, [])
  );

  const MAX_VISIBLE_PROJECTS = 6;
  let start = 0;
  if (projects.length > MAX_VISIBLE_PROJECTS) {
    const anchor = safe < projects.length ? safe : projects.length - 1;
    start = Math.max(0, Math.min(anchor - Math.floor(MAX_VISIBLE_PROJECTS / 2), projects.length - MAX_VISIBLE_PROJECTS));
  }
  const visibleProjects = projects.slice(start, start + MAX_VISIBLE_PROJECTS);

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={theme.accent}
      paddingX={2}
      paddingY={1}
    >
      <Box flexDirection="column" alignItems="center" marginBottom={1}>
        <GlowingLogo theme={theme} animated={true} />
      </Box>


      {projects.length > 0 ? (
        <>
          <Text color={theme.muted} dimColor>
            Recent Projects:{projects.length > MAX_VISIBLE_PROJECTS ? ` (${safe < projects.length ? safe + 1 : projects.length}/${projects.length})` : ""}
          </Text>
          <Box marginTop={0} />
          {start > 0 && (
            <Text color={theme.muted} dimColor>
              {"  "}... and {start} more projects above
            </Text>
          )}
          {visibleProjects.map((p, i) => {
            const realIdx = start + i;
            const selected = realIdx === safe;
            return (
              <Text
                key={p.path}
                color={selected ? theme.text : theme.muted}
                bold={selected}
              >
                {selected ? "▸ " : "  "}
                <Text color={selected ? theme.accent : theme.muted}>
                  {padEndWide(p.name, 16)}
                </Text>
                <Text color={theme.muted} dimColor={!selected}>
                  {p.path}
                </Text>
                {"  "}
                <Text color={theme.muted} dimColor>
                  {p.sessionCount > 0 ? `${p.sessionCount} sessions` : ""}
                </Text>
              </Text>
            );
          })}
          {start + MAX_VISIBLE_PROJECTS < projects.length && (
            <Text color={theme.muted} dimColor>
              {"  "}... and {projects.length - start - MAX_VISIBLE_PROJECTS} more projects below
            </Text>
          )}
        </>
      ) : (
        <Text color={theme.muted}>No recent projects.</Text>
      )}

      {cwdIsProject ? (
        <>
          <Box marginTop={1} />
          <Text
            color={safe === projects.length ? theme.text : theme.muted}
            bold={safe === projects.length}
          >
            {safe === projects.length ? "▸ " : "  "}
            <Text color={safe === projects.length ? theme.success : theme.muted}>
              ○ Use current directory
            </Text>
            {"  "}
            <Text color={theme.muted} dimColor>
              ({cwd})
            </Text>
          </Text>
        </>
      ) : null}

      <Box marginTop={1} />
      <Text color={theme.muted} dimColor>
        ↑↓ navigate · Enter select · Esc cancel
      </Text>
    </Box>
  );
}
