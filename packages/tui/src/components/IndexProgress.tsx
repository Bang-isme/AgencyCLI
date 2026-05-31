import { Box, Text } from "ink";
import type { ThemeTokens } from "../themes/registry.js";
import { useTick } from "../motion/useTick.js";
import { AGENCY_SPINNER, scanBar } from "../motion/design-system.js";
import { formatCount } from "../utils/text.js";
import { type IndexProgress as IndexProgressData, formatElapsed } from "@agency/core";

export interface IndexProgressProps {
  theme: ThemeTokens;
  progress: IndexProgressData | null;
  active: boolean;
}

const PHASE_LABEL: Record<string, string> = {
  scanning: "Scanning files",
  hashing: "Indexing content",
  writing: "Writing index",
};

export function IndexProgressPanel({
  theme,
  progress,
  active,
}: IndexProgressProps) {
  const tick = useTick(active, 100);

  if (!progress) return null;

  const label = PHASE_LABEL[progress.phase] ?? progress.phase;

  return (
    <Box flexDirection="column" marginTop={1} marginBottom={0}>
      <Box marginLeft={2} flexDirection="row">
        <Text color={theme.accent} bold>
          ◈ INDEXING CODEBASE{" "}
        </Text>
        <Text color={theme.accent}>{AGENCY_SPINNER[tick % AGENCY_SPINNER.length]}</Text>
      </Box>
      <Box
        borderStyle="single"
        borderColor={theme.accent}
        borderLeft
        borderRight={false}
        borderTop={false}
        borderBottom={false}
        paddingLeft={1}
        marginLeft={1}
      >
        <Box flexDirection="row">
          <Text color={theme.text} bold>
            Phase:{" "}
          </Text>
          <Text color={theme.muted}>{label}... </Text>
          <Text color={theme.accent}>[{scanBar(20, tick)}]</Text>
        </Box>
        <Box flexDirection="row">
          <Text color={theme.text} bold>
            Stats:{" "}
          </Text>
          <Text color={theme.muted}>
            {formatCount(progress.scannedFiles)} files · {formatElapsed(progress.elapsedMs)} ·{" "}
            <Text color={theme.muted} dimColor>
              esc cancel
            </Text>
          </Text>
        </Box>
      </Box>
    </Box>
  );
}
