/** @deprecated Use getTheme() from themes/registry — kept for backward-compatible imports. */
export {
  getTheme,
  THEMES,
  DEFAULT_THEME_ID,
  listThemeIds,
} from "./themes/registry.js";
export type { ThemeTokens } from "./themes/registry.js";

import { getTheme, DEFAULT_THEME_ID } from "./themes/registry.js";

export const theme = getTheme(DEFAULT_THEME_ID);
