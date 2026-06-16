import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { Box, Text, useInput } from "ink";
import { readdirSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ThemeTokens } from "../themes/registry.js";
import { aliasesForSkill } from "@agency/core";
import { useTerminalLayout } from "../layout/TerminalLayoutProvider.js";
import { panelWidth } from "../layout/terminal-layout.js";

export interface SkillItem {
  alias: string;
  fullName: string;
  purpose: string;
  icon: string;
}

const ICON_MAP: Record<string, string> = {
  $plan: "◈",
  $tdd: "◆",
  $debug: "◈",
  $gate: "■",
  $sdd: "◈",
  $git: "◆",
  $verify: "◈",
  $memory: "■",
  $spec: "◆",
  $workflow: "◈",
  $rigor: "◆",
  $security: "■",
  $intent: "◈",
  $master: "◈",
  $hook: "◆",
  "codex-design-system": "◈",
  "codex-design-md": "◆",
  "codex-doc-renderer": "◈",
  "codex-docs-change-sync": "◆",
  "codex-document-writer": "◈",
  "codex-domain-specialist": "◆",
  "codex-git-worktrees": "◈",
  "codex-project-pulse": "◆",
  "codex-role-docs": "◈",
  "codex-scrum-subagents": "◆",
  "codex-branch-finisher": "■",
  "codex-context-engine": "◈",
  "codex-logical-decision-layer": "■",
};

/**
 * The canonical alias the picker shows + injects for a skill. Sourced from the
 * shared `SKILL_ALIASES` map (via `aliasesForSkill`) so the injected token always
 * resolves back to this exact skill in the router — no divergent local copy. The
 * first registered alias is the primary; a skill with no alias falls back to its
 * folder-derived `$<bare>` form (still works via the resolver's bare fallback).
 */
function getAlias(folderName: string): string {
  const known = aliasesForSkill(folderName);
  if (known.length > 0) return known[0]!;
  const bare = folderName.replace(/^codex-/, "");
  return `$${bare}`;
}

function getIcon(folderName: string, alias: string): string {
  if (ICON_MAP[alias]) return ICON_MAP[alias]!;
  if (ICON_MAP[folderName]) return ICON_MAP[folderName]!;
  return "◆";
}

function loadSkills(skillsRoot: string): SkillItem[] {
  try {
    const dirs = readdirSync(skillsRoot, { withFileTypes: true });
    const available: SkillItem[] = [];

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
          const fullName = d.name;
          let purpose = "";
          try {
            const content = readFileSync(skillMd, "utf8");
            const descMatch = content.match(/^description:\s*(.+)$/m);
            if (descMatch && descMatch[1]) {
              purpose = descMatch[1].replace(/['"]/g, "").trim();
            }
          } catch {}

          const alias = getAlias(fullName);
          const icon = getIcon(fullName, alias);

          available.push({
            alias,
            fullName,
            purpose,
            icon,
          });
        }
      }
    }

    // Sort by alias name alphabetically
    available.sort((a, b) => a.alias.localeCompare(b.alias));
    return available;
  } catch {
    return [];
  }
}

export interface SkillsPickerProps {
  theme: ThemeTokens;
  skillsRoot: string;
  onSelect: (skill: SkillItem) => void;
  onClose: () => void;
  maxVisible?: number;
}

export function SkillsPicker({
  theme,
  skillsRoot,
  onSelect,
  onClose,
  maxVisible = 10,
}: SkillsPickerProps) {
  const { cols } = useTerminalLayout();
  const overlayWidth = panelWidth(cols, 90, 55);
  const innerWidth = overlayWidth - 4;
  const dividerStr = "─".repeat(Math.max(0, innerWidth));
  const [skills, setSkills] = useState<SkillItem[]>(() => loadSkills(skillsRoot));
  const maxAliasLen = skills.length > 0 ? Math.max(...skills.map((s) => s.alias.length)) : 10;
  const aliasColW = Math.min(22, Math.max(10, maxAliasLen + 2));
  const [index, setIndex] = useState(0);
  const [searchQuery, setSearchQuery] = useState("");

  useEffect(() => {
    const loaded = loadSkills(skillsRoot);
    setSkills(loaded);
    setIndex((i) => Math.min(Math.max(0, loaded.length - 1), i));
    setSearchQuery("");
  }, [skillsRoot]);

  const filteredSkills = useMemo(() => {
    if (!searchQuery) return skills;
    const q = searchQuery.toLowerCase();
    return skills.filter((s) =>
      (s.alias || "").toLowerCase().includes(q) ||
      (s.fullName || "").toLowerCase().includes(q) ||
      (s.purpose || "").toLowerCase().includes(q)
    );
  }, [skills, searchQuery]);

  const safe = filteredSkills.length === 0 ? 0 : index % filteredSkills.length;

  const stateRef = useRef({
    skills: filteredSkills,
    safe,
    onClose,
    onSelect,
    searchQuery,
  });

  useEffect(() => {
    stateRef.current = {
      skills: filteredSkills,
      safe,
      onClose,
      onSelect,
      searchQuery,
    };
  });

  useInput(
    useCallback((input, key) => {
      const { skills, safe, onClose, onSelect, searchQuery } = stateRef.current;
      if (key.escape) {
        if (searchQuery) {
          setSearchQuery("");
          setIndex(0);
          return;
        }
        onClose();
        return;
      }
      if (skills.length === 0) return;
      if (key.upArrow) {
        setIndex((i) => (i === 0 ? skills.length - 1 : i - 1));
        return;
      }
      if (key.downArrow) {
        setIndex((i) => (i === skills.length - 1 ? 0 : i + 1));
        return;
      }
      if (key.return) {
        const item = skills[safe];
        if (item) onSelect(item);
        return;
      }

      // Fast Search Typing Interceptor
      const isBackspace = key.backspace || key.delete || (key as any).name === "backspace" || (key as any).name === "delete" || input === "\b" || input === "\x08" || input === "\x7f";
      if (isBackspace) {
        setSearchQuery((q) => q.slice(0, -1));
        setIndex(0);
        return;
      }
      const isPrintable = input.length === 1 && input.charCodeAt(0) >= 32 && input.charCodeAt(0) !== 127;
      if (isPrintable) {
        setSearchQuery((q) => q + input);
        setIndex(0);
        return;
      }
    }, [])
  );

  // Sliding window list to prevent vertical height shifts/overflows
  let start = 0;
  if (filteredSkills.length > maxVisible) {
    start = Math.max(
      0,
      Math.min(safe - Math.floor(maxVisible / 2), filteredSkills.length - maxVisible)
    );
  }
  const visibleSkills = filteredSkills.slice(start, start + maxVisible);

  const scrollUpHint = start > 0 ? ` (▲ ${start} above)` : "";
  const scrollDownHint = start + maxVisible < filteredSkills.length ? ` (▼ ${filteredSkills.length - start - maxVisible} below)` : "";

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
          Select Skill{scrollUpHint}
        </Text>
        <Text color={theme.muted} wrap="wrap">
          ({safe + 1}/{filteredSkills.length})
        </Text>
      </Box>
      <Text color={theme.muted} dimColor wrap="wrap">
        Select a skill to add to your prompt
      </Text>
      <Text color={theme.dimBorder}>{dividerStr}</Text>

      {/* Search input */}
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
          <Text color={theme.muted} italic>Type to filter skills...</Text>
        )}
        <Text color={theme.accent} bold>|</Text>
      </Box>
      <Text color={theme.dimBorder}>{dividerStr}</Text>

      <Box flexDirection="column" marginY={0} overflow="hidden">
        {filteredSkills.length === 0 ? (
          <Box marginY={1} overflow="hidden">
            <Text color={theme.muted} wrap="wrap">No skills match search criteria.</Text>
          </Box>
        ) : (
          visibleSkills.map((item, vi) => {
            const realIdx = start + vi;
            const sel = realIdx === safe;
            const arrowStr = sel ? "▸  " : "   ";
            const iconStr = sel ? "■  " : "◇  ";
            const aliasStr = item.alias.padEnd(aliasColW);

            return (
              <Box key={item.alias} width={innerWidth} overflow="hidden">
                <Text wrap="wrap">
                  <Text color={sel ? theme.accent : theme.muted}>
                    {arrowStr}
                  </Text>
                  <Text color={sel ? theme.accent : theme.muted}>
                    {iconStr}
                  </Text>
                  <Text color={sel ? theme.accent : theme.warning} bold={sel}>
                    {aliasStr}
                  </Text>
                  <Text color={sel ? theme.text : theme.muted}>
                    {item.purpose}
                  </Text>
                </Text>
              </Box>
            );
          })
        )}
      </Box>

      <Text color={theme.dimBorder}>{dividerStr}</Text>
      <Box marginBottom={1} overflow="hidden">
        <Text color={theme.muted} dimColor wrap="wrap">
          {searchQuery
            ? `Enter to add · Backspace edit search · Esc to clear${scrollDownHint}`
            : (innerWidth >= 45 ? `Enter to add to prompt · ↑↓ navigate · Esc close${scrollDownHint}` : `Enter:add · ↑↓:nav · Esc:close${scrollDownHint}`)}
        </Text>
      </Box>
    </Box>
  );
}
