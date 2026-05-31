import { Command } from "commander";
import {
  abortCheckpoint,
  listCheckpoints,
  resolveSkillsRoot,
  runPlan,
} from "@agency/core";
import { resolveProjectRoot } from "../resolve-project.js";

export function registerTask(program: Command) {
  const task = program
    .command("task")
    .description("Long-running plan runner with checkpoints");

  task
    .command("start")
    .argument("<plan>", "Markdown plan file (e.g. agency-cli.md)")
    .description("Start executing tasks from a plan")
    .option("--from <n>", "Start at task number N", (v) => parseInt(v, 10))
    .option("--project-root <path>", "Project root directory")
    .option("--gate-every <n>", "Run auto_gate every N tasks (0=off)", (v) =>
      parseInt(v, 10)
    )
    .option("--harness", "Enable closed-loop verification self-correction harness")
    .option("--max-attempts <n>", "Max attempts for the harness loop", (v) =>
      parseInt(v, 10)
    )
    .action(
      async (
        plan: string,
        options: {
          from?: number;
          projectRoot?: string;
          gateEvery?: number;
          harness?: boolean;
          maxAttempts?: number;
        }
      ) => {
        const projectRoot = resolveProjectRoot(options.projectRoot);
        try {
          const cp = await runPlan(projectRoot, plan, {
            from: options.from,
            skillsRoot: resolveSkillsRoot(),
            gateEvery: options.gateEvery,
            harness: options.harness,
            maxAttempts: options.maxAttempts,
          });
          console.log(`Task run ${cp.status}: ${cp.id}`);
          console.log(
            `Completed: ${cp.completed.length} task(s) — [${cp.completed.join(", ")}]`
          );
          process.exit(cp.status === "done" ? 0 : 1);
        } catch (err) {
          console.error(err instanceof Error ? err.message : String(err));
          process.exit(1);
        }
      }
    );

  task
    .command("resume")
    .argument("<id>", "Checkpoint id")
    .description("Resume a plan run from its last checkpoint")
    .option("--project-root <path>", "Project root directory")
    .option("--gate-every <n>", "Run auto_gate every N tasks (0=off)", (v) =>
      parseInt(v, 10)
    )
    .option("--harness", "Enable closed-loop verification self-correction harness")
    .option("--max-attempts <n>", "Max attempts for the harness loop", (v) =>
      parseInt(v, 10)
    )
    .action(
      async (
        id: string,
        options: {
          projectRoot?: string;
          gateEvery?: number;
          harness?: boolean;
          maxAttempts?: number;
        }
      ) => {
        const projectRoot = resolveProjectRoot(options.projectRoot);
        try {
          const cp = await runPlan(projectRoot, "", {
            taskId: id,
            skillsRoot: resolveSkillsRoot(),
            gateEvery: options.gateEvery,
            harness: options.harness,
            maxAttempts: options.maxAttempts,
          });
          console.log(`Task run ${cp.status}: ${cp.id}`);
          console.log(
            `Completed: ${cp.completed.length} task(s) — [${cp.completed.join(", ")}]`
          );
          process.exit(cp.status === "done" ? 0 : 1);
        } catch (err) {
          console.error(err instanceof Error ? err.message : String(err));
          process.exit(1);
        }
      }
    );

  task
    .command("list")
    .description("List saved task checkpoints")
    .option("--project-root <path>", "Project root directory")
    .action((options: { projectRoot?: string }) => {
      const projectRoot = resolveProjectRoot(options.projectRoot);
      const checkpoints = listCheckpoints(projectRoot);
      if (checkpoints.length === 0) {
        console.log("No task checkpoints.");
        return;
      }
      for (const cp of checkpoints) {
        console.log(
          `${cp.id}  ${cp.status.padEnd(8)}  task ${cp.currentTask}  completed [${cp.completed.join(", ")}]  ${cp.planPath}`
        );
      }
    });

  task
    .command("abort")
    .argument("<id>", "Checkpoint id")
    .description("Abort a running or paused task run")
    .option("--project-root <path>", "Project root directory")
    .action((id: string, options: { projectRoot?: string }) => {
      const projectRoot = resolveProjectRoot(options.projectRoot);
      const ok = abortCheckpoint(projectRoot, id);
      if (!ok) {
        console.error(`Checkpoint not found or already done: ${id}`);
        process.exit(1);
      }
      console.log(`Aborted task run: ${id}`);
    });
}
