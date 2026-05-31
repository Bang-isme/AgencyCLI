export interface ThemeTokens {
  bg: string;
  panel: string;
  border: string;
  dimBorder: string;
  text: string;
  muted: string;
  accent: string;
  highlight: string;
  success: string;
  warning: string;
  danger: string;
}

export const THEMES: Record<string, ThemeTokens> = {
  agency: {
    bg: "#1e1e2e",       // Soft dark mocha (extremely comfortable for long sessions)
    panel: "#181825",    // Rich near-black mocha panel
    border: "#313244",   // Soft gray-blue border
    dimBorder: "#252538",// Subtle interior lines
    text: "#cdd6f4",     // Soft warm gray-white (eliminates high-contrast glare)
    muted: "#7f849c",    // Comforting medium gray for thought streams
    accent: "#cba6f7",   // Lavender purple (Agent cognition & reasoning)
    highlight: "#89dceb",// Light pastel cyan (Interactive states & actions)
    success: "#a6e3a1",  // Soft green (Verified execution states)
    warning: "#f9e2af",  // Soft amber (Elevated warnings/decisions)
    danger: "#f38ba8",   // Soft rose red (Failed states & errors)
  },
  daylight: {
    bg: "#fdf6e3",       // Solarized Base3 (Warm cream paper background)
    panel: "#eee8d5",    // Solarized Base2 (Highlight panel)
    border: "#93a1a1",   // Solarized Base1 (Slate border)
    dimBorder: "#e4dec9",// Subtle interior lines
    text: "#586e75",     // Solarized Base01 (Comfortable slate-brown dark text)
    muted: "#93a1a1",    // Solarized Base1 (Muted gray)
    accent: "#6c71c4",   // Violet (Agent cognition & reasoning)
    highlight: "#268bd2",// Blue (Interactive states & actions)
    success: "#859900",  // Green (Verified execution states)
    warning: "#b58900",  // Yellow/Amber (Elevated warnings/decisions)
    danger: "#dc322f",   // Red (Failed states & errors)
  },
};

export type ThemeId = keyof typeof THEMES;

export const DEFAULT_THEME_ID: ThemeId = "agency";

export function getTheme(id: string): ThemeTokens {
  return THEMES[id] ?? THEMES[DEFAULT_THEME_ID]!;
}

export function listThemeIds(): ThemeId[] {
  return Object.keys(THEMES) as ThemeId[];
}
