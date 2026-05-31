/** Optional terminal feedback (bell). Set AGENCY_TUI_SOUND=1 to enable. */
export function terminalBell(): void {
  if (process.env.AGENCY_TUI_SOUND === "1") {
    process.stdout.write("\u0007");
  }
}
