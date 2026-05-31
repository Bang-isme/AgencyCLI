import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { isAgentId, type AgentId } from "./types.js";

export interface CustomAgentConfig {
  disciplines?: string[];
  promptTemplate?: string;
}

export interface CustomAgentsFile {
  agents?: Record<string, CustomAgentConfig>;
}

export function loadCustomAgents(projectRoot?: string): Record<string, CustomAgentConfig> {
  if (!projectRoot) return {};
  const path = join(projectRoot, ".agency", "agents.json");
  if (!existsSync(path)) return {};
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as CustomAgentsFile;
    return raw.agents ?? {};
  } catch {
    return {};
  }
}

/** Discipline skills surfaced to the coordinator after dispatch. */
export const AGENT_DISCIPLINES: Partial<Record<AgentId, string[]>> = {
  debugger: ["codex-systematic-debugging", "codex-test-driven-development"],
  "test-engineer": ["codex-test-driven-development"],
  "frontend-specialist": ["codex-test-driven-development"],
  "backend-specialist": ["codex-test-driven-development"],
  planner: ["codex-plan-writer", "codex-subagent-execution"],
  "scrum-master": ["codex-scrum-subagents"],
  "security-auditor": ["codex-security-specialist"],
  "devops-engineer": ["codex-security-specialist"],
};

/** Subagent prompt template under codex-subagent-execution/agents/. */
export const AGENT_SUBAGENT_PROMPT: Partial<Record<AgentId, string>> = {
  planner: "implementer-prompt.md",
  debugger: "implementer-prompt.md",
  "frontend-specialist": "implementer-prompt.md",
  "backend-specialist": "implementer-prompt.md",
  "test-engineer": "implementer-prompt.md",
  "security-auditor": "code-quality-reviewer-prompt.md",
  "devops-engineer": "implementer-prompt.md",
  "scrum-master": "implementer-prompt.md",
};

export function coerceAgentId(
  suggested: string | null | undefined,
  fallback: AgentId,
  projectRoot?: string
): AgentId {
  if (suggested && isAgentId(suggested, projectRoot)) return suggested;
  return fallback;
}

export function subagentPromptPath(
  skillsRoot: string,
  agentId: AgentId,
  projectRoot?: string
): string | null {
  const custom = loadCustomAgents(projectRoot);
  const file = custom[agentId as string]?.promptTemplate ?? AGENT_SUBAGENT_PROMPT[agentId];
  if (!file) return null;

  if (projectRoot) {
    const localPath = resolve(projectRoot, ".agency", "agents", file);
    if (existsSync(localPath)) return localPath;
  }

  const path = join(
    skillsRoot,
    "codex-subagent-execution",
    "agents",
    file
  );
  return existsSync(path) ? path : null;
}
