import { Command } from "commander";
import {
  addSchedule,
  everyFlagToCron,
  getWorkspaceRoot,
  isWorkflowName,
  listSchedules,
  listWorkflowNames,
  removeSchedule,
  runDueSchedules,
  ScheduleNotFoundError,
  type WorkflowName,
} from "@agency/core";

export function registerSchedule(program: Command) {
  const schedule = program
    .command("schedule")
    .description("Cron-like local workflow scheduler (.agency/schedules.json)");

  schedule
    .command("list")
    .description("List configured schedules")
    .option("--project-root <path>", "Project root (storage for schedules.json)")
    .action((options: { projectRoot?: string }) => {
      const storageRoot =
        options.projectRoot ?? getWorkspaceRoot(process.cwd());
      const entries = listSchedules(storageRoot);
      if (entries.length === 0) {
        console.log("No schedules.");
        return;
      }
      for (const e of entries) {
        const flags = [
          e.enabled ? "enabled" : "disabled",
          e.requireApproval ? "approval" : "auto",
        ].join(", ");
        console.log(
          `${e.id}  ${e.workflow}  ${e.cron}  ${flags}  next=${e.nextRun ?? "—"}  root=${e.projectRoot}`
        );
      }
    });

  schedule
    .command("add")
    .description("Add a workflow schedule")
    .requiredOption("--workflow <name>", "Workflow name (create, plan, debug, …)")
    .option("--every <expr>", "Interval: 5m, 1h, or daily time 09:00")
    .option("--cron <expr>", "Cron expression (every:5m, daily:09:00, or 5-field cron)")
    .option("--require-approval", "Require --yes when schedule runs")
    .option("--project-root <path>", "Target project for the workflow")
    .option(
      "--storage-root <path>",
      "Where to store .agency/schedules.json (defaults to project-root or workspace)"
    )
    .action(
      (options: {
        workflow: string;
        every?: string;
        cron?: string;
        requireApproval?: boolean;
        projectRoot?: string;
        storageRoot?: string;
      }) => {
        if (!isWorkflowName(options.workflow)) {
          console.error(
            `Unknown workflow: ${options.workflow}. Available: ${listWorkflowNames().join(", ")}`
          );
          process.exit(1);
        }

        const cronExpr = options.cron
          ? options.cron
          : options.every
            ? everyFlagToCron(options.every)
            : null;
        if (!cronExpr) {
          console.error("Provide --every <5m|1h|09:00> or --cron <expression>.");
          process.exit(1);
        }

        const projectRoot =
          options.projectRoot ?? getWorkspaceRoot(process.cwd());
        const storageRoot = options.storageRoot ?? projectRoot;

        try {
          const entry = addSchedule(storageRoot, {
            workflow: options.workflow as WorkflowName,
            cron: cronExpr,
            projectRoot,
            requireApproval: options.requireApproval ?? false,
          });
          console.log(JSON.stringify(entry, null, 2));
        } catch (err) {
          console.error(err instanceof Error ? err.message : String(err));
          process.exit(1);
        }
      }
    );

  schedule
    .command("remove")
    .description("Remove a schedule by id")
    .argument("<id>", "Schedule id")
    .option("--project-root <path>", "Storage root for schedules.json")
    .action((id: string, options: { projectRoot?: string }) => {
      const storageRoot =
        options.projectRoot ?? getWorkspaceRoot(process.cwd());
      try {
        removeSchedule(storageRoot, id);
        console.log(`Removed schedule ${id}`);
      } catch (err) {
        if (err instanceof ScheduleNotFoundError) {
          console.error(err.message);
          process.exit(1);
        }
        throw err;
      }
    });

  schedule
    .command("run")
    .description("Run all due schedules now (no background daemon)")
    .option("--yes", "Approve workflows that require approval")
    .option("--project-root <path>", "Storage root for schedules.json")
    .action(async (options: { yes?: boolean; projectRoot?: string }) => {
      const storageRoot =
        options.projectRoot ?? getWorkspaceRoot(process.cwd());
      const results = await runDueSchedules(storageRoot, { yes: options.yes });
      if (results.length === 0) {
        console.log("No due schedules.");
        return;
      }
      for (const r of results) {
        const detail = r.reason ? ` (${r.reason})` : "";
        console.log(`${r.id}  ${r.workflow}  ${r.status}${detail}`);
      }
      const failed = results.some(
        (r) => r.status === "failed" || r.status === "skipped"
      );
      if (failed) process.exit(1);
    });
}
