import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const MANIFEST_AGENTS = [
  "frontend-specialist",
  "backend-specialist",
  "security-auditor",
  "debugger",
  "test-engineer",
  "devops-engineer",
  "planner",
  "scrum-master",
] as const;

export type AgentId = (typeof MANIFEST_AGENTS)[number] | (string & {});

export function isAgentId(id: string, projectRoot?: string): boolean {
  if ((MANIFEST_AGENTS as readonly string[]).includes(id)) return true;
  if (projectRoot) {
    const path = join(projectRoot, ".agency", "agents.json");
    if (existsSync(path)) {
      try {
        const raw = JSON.parse(readFileSync(path, "utf8"));
        const custom = raw?.agents ?? {};
        return id in custom;
      } catch {}
    }
  }
  return false;
}
