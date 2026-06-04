import { createElement } from "react";
import { render as inkRender } from "ink";
import { App } from "./App.js";
import { AppErrorBoundary } from "./components/AppErrorBoundary.js";
import { TerminalLayoutProvider } from "./layout/TerminalLayoutProvider.js";
import {
  enterAlternateScreen,
  leaveAlternateScreen,
} from "./terminal/screen.js";

export { App } from "./App.js";
export type { AppProps } from "./App.js";
export type { ScreenId } from "./types.js";
export { theme, getTheme, listThemeIds } from "./theme.js";
export type { PendingApproval } from "./screens/Approval.js";
export { parseSlashCommand, executeSlash } from "./slash/commands.js";
export {
  createSession,
  loadLatestSession,
  listSessionIds,
} from "./sessions/store.js";

// Runtime UX components
export { WorkerProgress } from "./components/WorkerProgress.js";
export type { WorkerProgressProps, WorkerStep, StepStatus } from "./components/WorkerProgress.js";
export { PatchCard } from "./components/PatchCard.js";
export type { PatchCardProps, PatchSymbol, PatchAction } from "./components/PatchCard.js";
export type { SubagentStatus } from "./state/subagent-status.js";

export interface RenderOptions {
  project?: string;
  skipSplash?: boolean;
}

/**
 * Launch the interactive Agency TUI (Agency-style shell).
 *
 * Uses the alternate screen buffer so your main shell scrollback is preserved.
 * Set `AGENCY_PENDING_TOOL` to open Approval on launch.
 * Set `AGENCY_TUI_SKIP_SPLASH=1` to skip the welcome animation.
 */
export function render(opts?: RenderOptions): void {
  process.env.AGENCY_TUI = "true";

  const skipSplash =
    opts?.skipSplash ?? process.env.AGENCY_TUI_SKIP_SPLASH === "1";

  const handleSigTerm = () => {
    leaveAlternateScreen();
    process.exit(143);
  };

  process.on("SIGTERM", handleSigTerm);

  enterAlternateScreen();
  const instance = inkRender(
    createElement(AppErrorBoundary, null,
      createElement(TerminalLayoutProvider, null,
        createElement(App, {
          project: opts?.project,
          skipSplash,
        })
      )
    ),
    { patchConsole: false }
  );
  void instance.waitUntilExit().finally(() => {
    process.off("SIGTERM", handleSigTerm);
    leaveAlternateScreen();
    process.exit(0);
  });
}
