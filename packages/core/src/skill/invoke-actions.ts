import { existsSync } from "node:fs";
import { join } from "node:path";
import { BUILTIN_SCRIPTS } from "@agency/skills-bridge";
import { resolveSkillsRoot } from "../skills-root.js";

const PLAN_CANDIDATES = ["plan.md", "agency-cli.md", "SPEC.md"] as const;

function findPlanFile(projectRoot: string): string | undefined {
  for (const name of PLAN_CANDIDATES) {
    if (existsSync(join(projectRoot, name))) return name;
  }
  return undefined;
}

function autoGateScriptPath(): string | undefined {
  try {
    const root = resolveSkillsRoot();
    const script = join(root, BUILTIN_SCRIPTS.auto_gate);
    return existsSync(script) ? script : undefined;
  } catch {
    const envRoot = process.env.AGENCY_SKILLS_ROOT;
    if (!envRoot) return undefined;
    const script = join(envRoot, BUILTIN_SCRIPTS.auto_gate);
    return existsSync(script) ? script : undefined;
  }
}

/** Actionable CLI commands after `agency skill invoke` for a resolved skill name. */
export function getInvokeActions(
  skillName: string,
  projectRoot: string
): string[] {
  switch (skillName) {
    case "codex-plan-writer": {
      const plan = findPlanFile(projectRoot);
      if (plan) return [`agency task start ${plan}`];
      return ['agency chat "create plan for <your goal>"'];
    }
    case "codex-subagent-execution":
      return [
        'agency agents dispatch planner --task "<describe your multi-step work>"',
      ];
    case "codex-execution-quality-gate": {
      const lines = ["agency workflow run create"];
      const script = autoGateScriptPath();
      if (script) {
        lines.push(`python ${script} --project-root ${projectRoot}`);
      }
      return lines;
    }
    default:
      return [`agency skill show ${skillName}`];
  }
}
