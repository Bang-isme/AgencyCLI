import { memo, useEffect, useState } from "react";
import { Box, Text } from "ink";
import type { ThemeTokens } from "../themes/registry.js";

export interface ErrorNotification {
  id: string;
  message: string;
  timestamp: number;
  dismissed?: boolean;
}

export interface ErrorBannerProps {
  theme: ThemeTokens;
  errors: ErrorNotification[];
  onDismiss: (id: string) => void;
  autoDismissMs?: number;
}

export const ErrorBanner = memo(function ErrorBanner({
  theme,
  errors,
  onDismiss,
  autoDismissMs = 8000,
}: ErrorBannerProps) {
  const [visibleErrors, setVisibleErrors] = useState<ErrorNotification[]>([]);

  useEffect(() => {
    const active = errors.filter((e) => !e.dismissed);
    setVisibleErrors(active);

    // Auto-dismiss after timeout
    if (autoDismissMs > 0 && active.length > 0) {
      const timers = active.map((err) =>
        setTimeout(() => onDismiss(err.id), autoDismissMs)
      );
      return () => timers.forEach(clearTimeout);
    }
  }, [errors, onDismiss, autoDismissMs]);

  if (visibleErrors.length === 0) return null;

  const latest = visibleErrors[visibleErrors.length - 1];

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={theme.danger}
      paddingX={1}
      marginX={1}
      marginBottom={1}
    >
      <Box flexDirection="row">
        <Text color={theme.danger} bold>
          ✕ ERROR
        </Text>
        <Text color={theme.muted}> · Press Esc to dismiss</Text>
      </Box>
      <Box marginTop={1}>
        <Text color={theme.text} wrap="wrap">
          {latest.message}
        </Text>
      </Box>
      {visibleErrors.length > 1 && (
        <Box marginTop={1}>
          <Text color={theme.muted} dimColor>
            +{visibleErrors.length - 1} more error{visibleErrors.length > 2 ? "s" : ""}
          </Text>
        </Box>
      )}
    </Box>
  );
});
