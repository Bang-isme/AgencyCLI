import type { BudgetMode } from "@agency/core";

/** The four agent interaction modes. */
export type AgentMode = "agent" | "plan" | "debug" | "ask";

export const AGENT_MODES: AgentMode[] = ["agent", "plan", "debug", "ask"];

export function nextMode(current: AgentMode): AgentMode {
  const idx = AGENT_MODES.indexOf(current);
  return AGENT_MODES[(idx + 1) % AGENT_MODES.length]!;
}

const LABELS: Record<AgentMode, string> = {
  agent: "Agent",
  plan: "Plan",
  debug: "Debug",
  ask: "Ask",
};

export function modeLabel(mode: AgentMode): string {
  return LABELS[mode];
}

const MODE_COLORS: Record<AgentMode, string> = {
  agent: "#58a6ff",  // blue
  plan: "#d29922",   // amber
  debug: "#f85149",  // red
  ask: "#3fb950",    // green
};

export function modeColor(mode: AgentMode): string {
  return MODE_COLORS[mode];
}

const BUDGETS: Record<AgentMode, BudgetMode> = {
  agent: "deep",
  plan: "normal",
  debug: "normal",
  ask: "normal",
};

export function modeBudget(mode: AgentMode): BudgetMode {
  return BUDGETS[mode];
}

const MODE_DESCRIPTIONS: Record<AgentMode, string> = {
  agent: "Full agent — plan, search, analyze & build",
  plan: "Architecture & implementation planning",
  debug: "Systematic debugging & root cause analysis",
  ask: "Ask anything about the codebase",
};

export function modeDescription(mode: AgentMode): string {
  return MODE_DESCRIPTIONS[mode];
}
