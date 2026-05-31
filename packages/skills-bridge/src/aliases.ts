export const SKILL_ALIASES: Record<string, string> = {
  $plan: "codex-plan-writer",
  $create: "codex-workflow-autopilot",
  $prototype: "codex-workflow-autopilot",
  $review: "codex-workflow-autopilot",
  $deploy: "codex-workflow-autopilot",
  $handoff: "codex-workflow-autopilot",
  $refactor: "codex-workflow-autopilot",
  $route: "codex-workflow-autopilot",
  $brainstorm: "codex-workflow-autopilot",
  $tdd: "codex-test-driven-development",
  $red_green: "codex-test-driven-development",
  "$red-green": "codex-test-driven-development",
  $gate: "codex-execution-quality-gate",
  $health: "codex-execution-quality-gate",
  $doctor: "codex-execution-quality-gate",
  $check: "codex-execution-quality-gate",
  "$check-full": "codex-execution-quality-gate",
  "$check-deploy": "codex-execution-quality-gate",
  "$install-hooks": "codex-execution-quality-gate",
  "$install-ci": "codex-execution-quality-gate",
  $guard: "codex-execution-quality-gate",
  $editorial: "codex-execution-quality-gate",
  $hook: "codex-runtime-hook",
  $preflight: "codex-runtime-hook",
  "$init-profile": "codex-runtime-hook",
  $sdd: "codex-subagent-execution",
  $dispatch: "codex-subagent-execution",
  "$review-feedback": "codex-subagent-execution",
  $debug: "codex-systematic-debugging",
  "$root-cause": "codex-systematic-debugging",
  $trace: "codex-systematic-debugging",
  $verify: "codex-verification-discipline",
  $evidence: "codex-verification-discipline",
  $memory: "codex-project-memory",
  $knowledge: "codex-project-memory",
  $genome: "codex-project-memory",
  $spec: "codex-spec-driven-development",
  $workflow: "codex-workflow-autopilot",
  $git: "codex-git-autopilot",
  $commit: "codex-git-autopilot",
  $worktree: "codex-git-worktrees",
  $isolate: "codex-git-worktrees",
  $rigor: "codex-reasoning-rigor",
  $master: "codex-master-instructions",
  $intent: "codex-intent-context-analyzer",
  $think: "codex-logical-decision-layer",
  $decide: "codex-logical-decision-layer",
  $security: "codex-security-specialist",
  $doc: "codex-document-writer",
  $report: "codex-document-writer",
  $write: "codex-document-writer",
  "$role-docs": "codex-role-docs",
  "$init-docs": "codex-role-docs",
  "$check-docs": "codex-role-docs",
  $design: "codex-design-system",
  "$design-md": "codex-design-md",
  $finish: "codex-branch-finisher",
  "$finish-branch": "codex-branch-finisher",
  "$scrum-install": "codex-scrum-subagents",
  "$scrum-update": "codex-scrum-subagents",
  "$scrum-diff": "codex-scrum-subagents",
  "$scrum-validate": "codex-scrum-subagents",
  "$sprint-plan": "codex-scrum-subagents",
  "$daily-scrum": "codex-scrum-subagents",
  "$story-delivery": "codex-scrum-subagents",
  $retro: "codex-scrum-subagents",
  "$release-readiness": "codex-scrum-subagents",
  "$project-pulse": "codex-project-pulse",
  $today: "codex-project-pulse",
};

export function resolveSkillAlias(input: string): string {
  if (Object.prototype.hasOwnProperty.call(SKILL_ALIASES, input)) {
    return SKILL_ALIASES[input]!;
  }
  if (input.startsWith("$")) {
    const bare = input.slice(1);
    return bare.startsWith("codex-") ? bare : `codex-${bare}`;
  }
  if (!input.startsWith("codex-")) {
    return `codex-${input}`;
  }
  return input;
}

export function aliasesForSkill(skillName: string): string[] {
  return Object.entries(SKILL_ALIASES)
    .filter(([, target]) => target === skillName)
    .map(([alias]) => alias);
}
