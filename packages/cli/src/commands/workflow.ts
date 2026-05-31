import { Command } from "commander";
import {
  ApprovalRequiredError,
  getWorkspaceRoot,
  isWorkflowName,
  listWorkflowNames,
  resolveSkillsRoot,
  runWorkflow,
  WORKFLOWS,
  type WorkflowName,
} from "@agency/core";
import { out, handleError } from "../utils.js";

export function registerWorkflow(program: Command) {
  const workflow = program
    .command("workflow")
    .description("Compose and run CodexAI workflow script chains");

  workflow
    .command("list")
    .description("List available workflows and their steps")
    .option("--json", "Machine-readable JSON output")
    .option("--quiet", "Suppress routing meta on stderr")
    .action((options: { json?: boolean; quiet?: boolean }) => {
      if (options.json) {
        out.configure({ surface: "json", quiet: options.quiet });
      } else {
        out.configure({ surface: "human", quiet: options.quiet });
      }

      if (options.json) {
        const workflowsJson: Record<string, string[]> = {};
        for (const name of listWorkflowNames()) {
          workflowsJson[name] = WORKFLOWS[name].map((s) => s.name);
        }
        out.json(workflowsJson);
        return;
      }

      const rows: string[][] = [];
      for (const name of listWorkflowNames()) {
        const steps = WORKFLOWS[name].map((s) => s.name).join(" ➔ ");
        rows.push([name, steps]);
      }
      out.table(["Workflow", "Execution Chain"], rows);
    });

  workflow
    .command("run")
    .description("Run a workflow against the project")
    .argument("<name>", "Workflow name (create, plan, debug, …)")
    .option("--project-root <path>", "Project root directory")
    .option("--prompt <text>", "Prompt for plan workflow route-plan step")
    .option(
      "--preflight",
      "Run runtime_hook preflight steps (slow; ~5min on large repos)"
    )
    .option("--yes", "Approve steps that write artifacts")
    .option("--json", "Machine-readable JSON output")
    .option("--quiet", "Suppress routing meta on stderr")
    .action(
      async (
        name: string,
        options: {
          projectRoot?: string;
          prompt?: string;
          preflight?: boolean;
          yes?: boolean;
          json?: boolean;
          quiet?: boolean;
        }
      ) => {
        if (options.json) {
          out.configure({ surface: "json", quiet: options.quiet });
        } else {
          out.configure({ surface: "human", quiet: options.quiet });
        }

        if (!isWorkflowName(name)) {
          out.failure({
            title: "unknown workflow",
            consequence: `${name} is not a valid workflow name`,
            recovery: `available: ${listWorkflowNames().join(", ")}`,
          });
          process.exit(1);
        }

        const workflowName = name as WorkflowName;
        const projectRoot =
          options.projectRoot ?? getWorkspaceRoot(process.cwd());
        const skillsRoot = resolveSkillsRoot();

        try {
          out.phase(`workflow ${workflowName} execution`, {
            project: projectRoot,
            preflight: String(!!options.preflight),
            yes: String(!!options.yes),
          });

          const { status, steps } = await runWorkflow(
            skillsRoot,
            projectRoot,
            workflowName,
            {
              yes: options.yes,
              prompt: options.prompt,
              preflight: options.preflight,
              onStep: (stepName, result) => {
                out.worker({
                  workerId: `workflow.${stepName}`,
                  status: result.exitCode === 0 ? "done" : "aborted",
                  task: `workflow step ${stepName}`,
                });
                if (result.stdout) out.passthrough(result.stdout);
                if (result.stderr) out.meta(result.stderr);
              },
            }
          );

          if (status === "failed") {
            const failed = steps.find((s) => s.exitCode !== 0);
            out.failure({
              title: `workflow ${workflowName} failed`,
              consequence: `workflow execution aborted on step: ${failed?.name ?? "unknown"}`,
              recovery: "inspect output and re-run",
            });
            process.exit(1);
          }

          if (options.json) {
            out.json({ status: "ok", workflow: workflowName, steps: steps.length });
          } else {
            out.phase(`workflow ${workflowName} completed`, { status: "ok" });
          }
        } catch (err) {
          if (err instanceof ApprovalRequiredError) {
            out.failure({
              title: "approval required",
              consequence: err.message,
              recovery: "re-run command with --yes or use TUI confirm",
            });
            process.exit(1);
          }
          handleError(err, "workflow execution failed");
        }
      }
    );
}
