import { memo } from "react";
import { Box, Text } from "ink";
import type { ThemeTokens } from "../themes/registry.js";
import { useDisclosure } from "../state/DisclosureProvider.js";
import { RuntimeThoughtEvent } from "@agency/core";
import {
  thoughtSeverityColor as severityColor,
  thoughtSeverityIcon as severityIcon,
} from "../utils/severity.js";

export interface CognitionPanelProps {
  theme: ThemeTokens;
  thoughts: RuntimeThoughtEvent[];
  width: number;
}

function formatTime(timestamp: number): string {
  const date = new Date(timestamp);
  return date.toTimeString().split(" ")[0] || "";
}

/**
 * Collapsible runtime thought event logging panel.
 *
 * Adheres to progressive disclosure levels (default/advanced/expert).
 */
export const CognitionPanel = memo(function CognitionPanel({
  theme,
  thoughts,
  width,
}: CognitionPanelProps) {
  const { level } = useDisclosure();

  if (thoughts.length === 0) return null;

  const showDetails = level !== "default";
  const displayThoughts = showDetails
    ? level === "expert"
      ? thoughts
      : thoughts.slice(-5) // show last 5 in advanced
    : thoughts.slice(-1); // show only the latest in default mode

  const counts = {
    info: thoughts.filter((t) => t.severity === "info").length,
    adaptation: thoughts.filter((t) => t.severity === "adaptation").length,
    warning: thoughts.filter((t) => t.severity === "warning").length,
    critical: thoughts.filter((t) => t.severity === "critical").length,
  };

  const hasCritical = counts.critical > 0;
  const hasWarning = counts.warning > 0;

  const panelBorderColor = hasCritical
    ? theme.danger
    : hasWarning
      ? theme.warning
      : theme.dimBorder;

  const innerWidth = width - (showDetails ? 4 : 2);

  return (
    <Box
      flexDirection="column"
      borderStyle={showDetails ? "single" : undefined}
      borderColor={panelBorderColor}
      paddingX={showDetails ? 1 : 0}
      width={width}
      marginBottom={0}
      marginTop={0}
      overflow="hidden"
    >
      {/* Title / Summary line */}
      <Box flexDirection="row" justifyContent="space-between" width={innerWidth}>
        <Box flexDirection="row">
          <Text color={theme.accent} bold>
            ● Cognition
          </Text>
          <Text color={theme.muted}>
            {"  "}{thoughts.length} events
            {counts.adaptation > 0 ? ` · ${counts.adaptation} adaptations` : ""}
            {counts.warning > 0 ? ` · ${counts.warning} warnings` : ""}
            {counts.critical > 0 ? ` · ${counts.critical} critical` : ""}
          </Text>
        </Box>
        {level === "default" ? (
          <Text color={theme.muted} dimColor>
            ctrl+d detailed log
          </Text>
        ) : null}
      </Box>

      {/* Thought event list */}
      <Box flexDirection="column" marginTop={0} width={innerWidth} overflow="hidden">
        {displayThoughts.map((t) => {
          const color = severityColor(theme, t.severity);
          const icon = severityIcon(t.severity);
          
          const metaParts = [];
          if (showDetails) metaParts.push(`[${formatTime(t.timestamp)}]`);
          if (t.source) metaParts.push(`[${t.source}]`);
          const metaLabel = metaParts.length > 0 ? `${metaParts.join(" ")} ` : "";
          const isBold = t.severity === "critical" || t.severity === "adaptation";

          return (
            <Box key={t.id} flexDirection="row" overflow="hidden" width={innerWidth}>
              <Text color={color} bold={isBold}>
                {icon}{" "}
              </Text>
              <Text wrap="wrap">
                {metaLabel ? <Text color={theme.muted} dimColor>{metaLabel}</Text> : null}
                <Text color={color === theme.muted ? theme.text : color} bold={isBold}>
                  {t.message}
                </Text>
              </Text>
            </Box>
          );
        })}
      </Box>
    </Box>
  );
});
