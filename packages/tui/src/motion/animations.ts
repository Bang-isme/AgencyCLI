/** When `AGENCY_TUI_ANIMATIONS=0`, motion helpers stay static. */
export function animationsEnabled(): boolean {
  const v = process.env.AGENCY_TUI_ANIMATIONS?.trim().toLowerCase();
  return v !== "0" && v !== "false" && v !== "off" && v !== "no";
}
