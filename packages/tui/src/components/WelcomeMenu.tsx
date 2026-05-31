import { Box, Text } from "ink";
import type { ThemeTokens } from "../themes/registry.js";
import { ScanningDivider } from "./Splash.js";
import { GlowingLogo } from "./GlowingLogo.js";
import { useTick } from "../motion/useTick.js";
import { useTerminalLayout } from "../layout/TerminalLayoutProvider.js";

export interface WelcomeMenuProps {
  theme: ThemeTokens;
  version?: string;
  selectedIndex: number;
  rows: number;
  cols: number;
}

const OPTIONS = [
  { label: "new worktree", desc: "Create a fresh session and clear context" },
  { label: "resume session", desc: "Select from recent workspace sessions" },
  { label: "quit", desc: "Exit the Agency system terminal safely" }
];

export function WelcomeMenu({
  theme,
  version = "0.1.0",
  selectedIndex,
}: WelcomeMenuProps) {
  const tick = useTick(true, 50);
  const { shellWidth, shellHeight, cols } = useTerminalLayout();
  const iconCycle = ["◈", "◇", "❖", "✦", "✧", "⬪", "⬩", "⬧"];
  const headerIcon = iconCycle[Math.floor(tick / 4) % iconCycle.length];

  const isNarrow = cols < 72;
  const welcomeWidth = isNarrow
    ? Math.max(30, Math.min(74, cols - 2))
    : Math.max(72, Math.min(74, cols - 2));
  const innerWidth = welcomeWidth - 6; // accounting for borders (2) and paddingX={2} (4)

  return (
    <Box
      flexDirection="column"
      height={shellHeight}
      width={shellWidth}
      alignItems="center"
      justifyContent="center"
    >
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor={theme.accent}
        width={welcomeWidth}
        paddingX={2}
      >
        {/* Header Title */}
        <Box justifyContent="space-between" overflow="hidden">
          <Text color={theme.accent} bold wrap="truncate">
            {headerIcon} {isNarrow ? "AGENCY" : "AGENCY SYSTEM KERNEL"}
          </Text>
          <Text color={theme.success} bold>
            <Text color={tick % 16 < 8 ? theme.success : theme.accent}>●</Text> ONLINE
          </Text>
        </Box>

        {/* Divider */}
        <ScanningDivider width={innerWidth} tick={tick} theme={theme} phaseOffset={0} />

        {/* Logo Section */}
        <Box flexDirection="column" alignItems="center" paddingY={0}>
          <GlowingLogo theme={theme} tick={tick} />
          <Box marginTop={1} overflow="hidden">
            <Text color={theme.muted} wrap="truncate">
              {isNarrow ? `v${version}` : `c o m m a n d   l i n e   i n t e r f a c e   v${version}`}
            </Text>
          </Box>
        </Box>

        {/* Divider */}
        <ScanningDivider width={innerWidth} tick={tick} theme={theme} phaseOffset={15} />

        {/* Options Menu */}
        <Box
          flexDirection="column"
          paddingY={isNarrow ? 1 : 2}
          paddingX={isNarrow ? 0 : 2}
          height={isNarrow ? 5 : 7}
          overflow="hidden"
        >
          {OPTIONS.map((opt, idx) => {
            const isSelected = idx === selectedIndex;
            const arrow = isSelected ? (tick % 8 < 4 ? "▸ " : "▹ ") : "  ";
            const paddedLabel = ` ${opt.label} `.padEnd(16);
            return (
              <Box key={opt.label} flexDirection="row" marginY={0} overflow="hidden">
                <Text color={isSelected ? theme.accent : theme.muted} bold={isSelected}>
                  {arrow}
                </Text>
                <Text
                  color={isSelected ? theme.bg : theme.muted}
                  backgroundColor={isSelected ? theme.accent : undefined}
                  bold={isSelected}
                >
                  {paddedLabel}
                </Text>
                {!isNarrow && (
                  <>
                    <Text color={isSelected ? theme.accent : theme.dimBorder}>
                      {` │ `}
                    </Text>
                    <Text color={isSelected ? theme.text : theme.muted} wrap="truncate">
                      {opt.desc}
                    </Text>
                  </>
                )}
              </Box>
            );
          })}
        </Box>

        {/* Divider */}
        <ScanningDivider width={innerWidth} tick={tick} theme={theme} phaseOffset={30} />

        {/* Footer */}
        <Box justifyContent="center" overflow="hidden">
          <Text color={theme.muted} dimColor wrap="truncate">
            {isNarrow ? "↑↓ navigate · Enter select" : "↑↓ navigate · Enter / Mouse Click select"}
          </Text>
        </Box>
      </Box>
    </Box>
  );
}
