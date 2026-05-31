import { execa } from "execa";
import { join } from "node:path";
import { resolvePythonBin } from "@agency/skills-bridge";
import { ApprovalRequiredError } from "../approval/policy.js";
import { SecurityEscalationManager, SecurityLevel } from "@agency/security";

export class SecurityClearanceError extends Error {
  override readonly name = "SecurityClearanceError";
  constructor(message: string) {
    super(message);
  }
}

export type WorkflowName =
  | "create"
  | "debug"
  | "review"
  | "deploy"
  | "plan"
  | "handoff"
  | "refactor"
  | "prototype";

export interface WorkflowStep {
  name: string;
  script: string;
  argv: (
    projectRoot: string,
    skillsRoot: string,
    opts?: RunWorkflowOptions
  ) => string[];
  requiresApproval?: boolean;
}

export interface RunStepResult {
  name: string;
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface RunWorkflowOptions {
  yes?: boolean;
  prompt?: string;
  /** Include runtime_hook preflight steps (slow; default false for token savings). */
  preflight?: boolean;
  onStep?: (name: string, result: RunStepResult) => void;
  maxSecurityLevel?: number;
  securityWhitelist?: string[];
}

export interface RunWorkflowResult {
  status: "ok" | "failed";
  steps: RunStepResult[];
}

// Note: do NOT append `--format json` here — several pack scripts
// (tech_debt_scan, security_scan, pre_commit_check, generate_handoff) reject it
// and abort the step. The composer captures raw stdout, so human output is fine.
const projectArgs = (p: string) => ["--project-root", p];

export const WORKFLOWS: Record<WorkflowName, WorkflowStep[]> = {
  create: [
    {
      name: "preflight",
      script: "codex-runtime-hook/scripts/runtime_hook.py",
      argv: (p) => projectArgs(p),
    },
    {
      name: "gate-quick",
      script: "codex-execution-quality-gate/scripts/auto_gate.py",
      argv: (p) => ["--project-root", p, "--mode", "quick"],
      requiresApproval: false,
    },
  ],
  plan: [
    {
      name: "preflight",
      script: "codex-runtime-hook/scripts/runtime_hook.py",
      argv: (p) => projectArgs(p),
    },
    {
      name: "route-plan",
      script: ".system/scripts/prompt_router.py",
      argv: (_p, _s, opts) => [
        "--prompt",
        opts?.prompt ?? "plan implementation",
        "--format",
        "json",
      ],
    },
  ],
  debug: [
    {
      name: "preflight",
      script: "codex-runtime-hook/scripts/runtime_hook.py",
      argv: (p) => projectArgs(p),
    },
    {
      name: "pre-commit",
      script: "codex-execution-quality-gate/scripts/pre_commit_check.py",
      argv: (p) => projectArgs(p),
    },
  ],
  review: [
    {
      name: "tech-debt",
      script: "codex-execution-quality-gate/scripts/tech_debt_scan.py",
      argv: (p) => projectArgs(p),
    },
    {
      name: "security",
      script: "codex-execution-quality-gate/scripts/security_scan.py",
      argv: (p) => projectArgs(p),
    },
  ],
  deploy: [
    {
      name: "gate-deploy",
      script: "codex-execution-quality-gate/scripts/auto_gate.py",
      argv: (p) => ["--project-root", p, "--mode", "deploy"],
      requiresApproval: false,
    },
  ],
  handoff: [
    {
      name: "memory-status",
      script: "codex-project-memory/scripts/memory_status.py",
      argv: (p) => projectArgs(p),
    },
    {
      name: "generate-handoff",
      script: "codex-project-memory/scripts/generate_handoff.py",
      argv: (p) => projectArgs(p),
      requiresApproval: true,
    },
  ],
  refactor: [
    {
      name: "preflight",
      script: "codex-runtime-hook/scripts/runtime_hook.py",
      argv: (p) => projectArgs(p),
    },
    {
      name: "tech-debt",
      script: "codex-execution-quality-gate/scripts/tech_debt_scan.py",
      argv: (p) => projectArgs(p),
    },
  ],
  prototype: [
    {
      name: "init-spec",
      script: "codex-spec-driven-development/scripts/init_spec.py",
      argv: (p) => ["--project-root", p, "--title", "prototype", "--format", "json"],
      requiresApproval: true,
    },
    {
      name: "check-spec",
      script: "codex-spec-driven-development/scripts/check_spec.py",
      argv: (p) => projectArgs(p),
    },
  ],
};

/** runtime_hook can exceed 5m on large repos; align with measured ~304s. */
export const RUNTIME_HOOK_TIMEOUT = 360_000;

const PREFLIGHT_STEP = "preflight";

export function resolveWorkflowSteps(
  workflow: WorkflowName,
  opts: RunWorkflowOptions = {}
): WorkflowStep[] {
  const steps = WORKFLOWS[workflow];
  if (opts.preflight) return steps;
  return steps.filter((s) => s.name !== PREFLIGHT_STEP);
}

async function runStep(
  skillsRoot: string,
  projectRoot: string,
  step: WorkflowStep,
  opts: RunWorkflowOptions = {}
): Promise<RunStepResult> {
  const script = join(skillsRoot, step.script);
  const argv = step.argv(projectRoot, skillsRoot, opts);
  const execOpts: { reject: false; timeout?: number } = { reject: false };
  if (step.script.includes("runtime_hook")) {
    execOpts.timeout = RUNTIME_HOOK_TIMEOUT;
  }
  const python = (await resolvePythonBin()) ?? "python";
  const result = await execa(python, [script, ...argv], execOpts);
  return {
    name: step.name,
    exitCode: result.exitCode ?? 1,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

export async function runWorkflow(
  skillsRoot: string,
  projectRoot: string,
  workflow: WorkflowName,
  opts: RunWorkflowOptions = {}
): Promise<RunWorkflowResult> {
  // Security clearance check
  const securityManager = new SecurityEscalationManager();
  const maxSecurityLevel = opts.maxSecurityLevel ?? SecurityLevel.Level5_Privileged;
  const whitelist = new Set(opts.securityWhitelist || []);

  const accessResult = securityManager.checkAccess("run_command", maxSecurityLevel, whitelist);
  if (!accessResult.allowed) {
    throw new SecurityClearanceError(accessResult.reason || `security clearance insufficient`);
  }

  const definition = resolveWorkflowSteps(workflow, opts);
  const steps: RunStepResult[] = [];

  for (const step of definition) {
    if (step.requiresApproval && !opts.yes) {
      throw new ApprovalRequiredError(
        `Workflow step "${step.name}" requires approval (--yes or TUI confirm)`
      );
    }

    const result = await runStep(skillsRoot, projectRoot, step, opts);
    steps.push(result);
    opts.onStep?.(step.name, result);

    if (result.exitCode !== 0) {
      return { status: "failed", steps };
    }
  }

  return { status: "ok", steps };
}

export function listWorkflowNames(): WorkflowName[] {
  return Object.keys(WORKFLOWS) as WorkflowName[];
}

export function isWorkflowName(name: string): name is WorkflowName {
  return Object.prototype.hasOwnProperty.call(WORKFLOWS, name);
}
