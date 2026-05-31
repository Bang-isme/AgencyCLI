export interface SlashMenuItem {
  name: string;
  desc: string;
}

export const SLASH_MENU: SlashMenuItem[] = [
  { name: "help", desc: "Shortcuts overlay" },
  { name: "new", desc: "New session" },
  { name: "connect", desc: "Setup providers & API keys" },
  { name: "models", desc: "Select model from providers" },
  { name: "skills", desc: "Browse & inject skills" },
  { name: "plugin", desc: "View installed skills pack" },
  { name: "review", desc: "Review commit/branch/PR/CI" },
  { name: "sessions", desc: "Manage and resume sessions" },
  { name: "project", desc: "Switch or add project" },
  { name: "status", desc: "System status dashboard (providers, context, sessions)" },
  { name: "mcp", desc: "Configure & manage MCP servers" },
  { name: "theme", desc: "Switch theme" },
  { name: "variant", desc: "Configure model thinking budget (e.g. off, low, high)" },
  { name: "index", desc: "Refresh @file index" },
  { name: "compact", desc: "Smart context compact" },
  { name: "goal", desc: "Long-running autonomous task" },
  { name: "schedule", desc: "Recurring cron task" },
  { name: "agents", desc: "View subagent dispatch" },
  { name: "route", desc: "Preview & correct how prompts are routed" },
  { name: "dashboard", desc: "Open browser knowledge & memory dashboard" },
  { name: "export", desc: "Export session markdown" },
  { name: "exit", desc: "Quit TUI" },
];

export function getSlashQuery(
  buffer: string
): { query: string } | null {
  if (!buffer.startsWith("/")) return null;
  const space = buffer.indexOf(" ");
  if (space !== -1) return null;
  return { query: buffer.slice(1).toLowerCase() };
}

export function filterSlashMenu(query: string): SlashMenuItem[] {
  const q = query.toLowerCase();
  if (!q) return SLASH_MENU;
  return SLASH_MENU.filter(
    (item) => item.name.startsWith(q) || item.name.includes(q)
  );
}
