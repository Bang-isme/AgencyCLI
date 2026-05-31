import { Component, type ReactNode } from "react";
import { Box, Text } from "ink";
import { reportRuntimeError } from "../terminal/screen.js";

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
  retries: number;
}

const MAX_AUTO_RECOVERIES = 3;
const RECOVERY_DELAY_MS = 1200;

/**
 * Catches React render errors so a thrown component can never unmount the whole
 * tree.
 *
 * Without this, an uncaught render throw unmounts the App → Ink's
 * `waitUntilExit()` resolves → the launcher leaves the alternate screen and
 * `process.exit(0)`s — i.e. the TUI silently drops you back to the shell (the
 * exact "văng ra khỏi CLI" symptom). The global `uncaughtException` handler
 * can't save this because React swallows the error into an unmount.
 *
 * Instead we render a calm fallback and auto-retry a few times (a transient
 * render race self-heals); if it keeps throwing we stay on the fallback so the
 * user can read the message and Ctrl+C out cleanly — still inside the TUI,
 * never ejected to the shell.
 */
export class AppErrorBoundary extends Component<Props, State> {
  private recoverTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(props: Props) {
    super(props);
    this.state = { error: null, retries: 0 };
  }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error): void {
    reportRuntimeError("Render Error", error);
    if (this.state.retries < MAX_AUTO_RECOVERIES) {
      this.recoverTimer = setTimeout(() => {
        this.setState((s) => ({ error: null, retries: s.retries + 1 }));
      }, RECOVERY_DELAY_MS);
    }
  }

  componentWillUnmount(): void {
    if (this.recoverTimer) clearTimeout(this.recoverTimer);
  }

  render(): ReactNode {
    if (this.state.error) {
      const recovering = this.state.retries < MAX_AUTO_RECOVERIES;
      return (
        <Box flexDirection="column" padding={1}>
          <Text color="red" bold>
            ⚠ The interface hit a render error — your session is still alive.
          </Text>
          <Text color="gray">{this.state.error.message}</Text>
          <Text color="gray" dimColor>
            {recovering
              ? "Recovering…"
              : "Press Ctrl+C to exit cleanly. Your work is saved under .agency/."}
          </Text>
        </Box>
      );
    }
    return this.props.children;
  }
}
