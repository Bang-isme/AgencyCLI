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
  catppuccin: {
    bg: "#1e1e2e",
    panel: "#181825",
    border: "#313244",
    dimBorder: "#45475a",
    text: "#cdd6f4",
    muted: "#7f849c",
    accent: "#cba6f7",
    highlight: "#f5c2e7",
    success: "#a6e3a1",
    warning: "#f9e2af",
    danger: "#f38ba8",
  },
  oneDark: {
    bg: "#282c34",
    panel: "#21252b",
    border: "#393f4a",
    dimBorder: "#2c313a",
    text: "#abb2bf",
    muted: "#5c6370",
    accent: "#56b6c2",
    highlight: "#61afef",
    success: "#98c379",
    warning: "#e5c07b",
    danger: "#e06c75",
  },
  tokyoNight: {
    bg: "#1a1b26",
    panel: "#1e2030",
    border: "#737aa2",
    dimBorder: "#545c7e",
    text: "#c8d3f5",
    muted: "#828bb8",
    accent: "#ff966c",
    highlight: "#82aaff",
    success: "#4fd6be",
    warning: "#ff966c",
    danger: "#ff757f",
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
