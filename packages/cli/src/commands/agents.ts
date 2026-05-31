import { Command } from "commander";
import {
  dispatchAgent,
  dispatchAgentsParallel,
  isAgentId,
  MANIFEST_AGENTS,
  resolveSkillsRoot,
} from "@agency/core";
import { resolveProjectRoot } from "../resolve-project.js";

export function registerAgents(program: Command) {
  const agents = program
    .command("agents")
    .description("Multi-agent orchestrator (fresh context per dispatch)");

  agents
    .command("list")
    .description("List available agent roles")
    .action(() => {
      for (const id of MANIFEST_AGENTS) {
        console.log(id);
      }
    });

  agents
    .command("dispatch")
    .description("Dispatch a task to an agent with isolated env")
    .argument("<agentId>", "Agent role id (see agency agents list)")
    .requiredOption("--task <text>", "Task description for the agent")
    .option("--project-root <path>", "Project root directory")
    .option("--no-llm", "Force route-only output (skip LLM even if API key is set)")
    .option(
      "--max-loops <number>",
      "Maximum execution loops for tool calls",
      (val) => parseInt(val, 10)
    )
    .action(
      async (
        agentId: string,
        // Commander stores `--no-llm` as `llm: false` (default true).
        options: { task: string; projectRoot?: string; maxLoops?: number; llm?: boolean }
      ) => {
        if (!isAgentId(agentId)) {
          console.error(
            `Unknown agent: ${agentId}. Available: ${MANIFEST_AGENTS.join(", ")}`
          );
          process.exit(1);
        }

        const projectRoot = resolveProjectRoot(options.projectRoot);

        try {
          const skillsRoot = resolveSkillsRoot();
          const result = await dispatchAgent(
            {
              agentId,
              task: options.task,
              projectRoot,
            },
            { skillsRoot, maxLoops: options.maxLoops, noLlm: options.llm === false }
          );

          if (result.stdout) {
            process.stdout.write(
              result.stdout + (result.stdout.endsWith("\n") ? "" : "\n")
            );
          }
          if (result.stderr) {
            process.stderr.write(result.stderr);
          }

          process.exit(result.exitCode === 0 ? 0 : 1);
        } catch (err: any) {
          if (err instanceof Error && err.message.startsWith("exit:")) {
            throw err;
          }
          console.error(err instanceof Error ? err.message : String(err));
          process.exit(1);
        }
      }
    );

  agents
    .command("parallel")
    .description("Run multiple subagents concurrently with workspace isolation")
    .option("--dispatches <json>", "JSON string of dispatches (e.g. '[{\"agentId\":\"planner\",\"task\":\"Draft plan\"}]')")
    .option("--dispatches-file <path>", "Path to JSON file of dispatches")
    .option("--project-root <path>", "Project root directory")
    .option("--no-llm", "Force route-only output (skip LLM even if API key is set)")
    .action(
      async (options: {
        dispatches?: string;
        dispatchesFile?: string;
        projectRoot?: string;
        // Commander stores `--no-llm` as `llm: false` (default true).
        llm?: boolean;
      }) => {
        const projectRoot = resolveProjectRoot(options.projectRoot);
        let rawDispatches: any[] = [];

        if (options.dispatches) {
          try {
            rawDispatches = JSON.parse(options.dispatches);
          } catch {
            console.error("Invalid JSON string in --dispatches option.");
            process.exit(1);
          }
        } else if (options.dispatchesFile) {
          try {
            const fs = await import("node:fs");
            const fileContent = fs.readFileSync(options.dispatchesFile, "utf8");
            rawDispatches = JSON.parse(fileContent);
          } catch (err) {
            console.error(`Failed to read/parse dispatches file: ${err instanceof Error ? err.message : String(err)}`);
            process.exit(1);
          }
        } else {
          console.error("You must specify either --dispatches <json> or --dispatches-file <path>.");
          process.exit(1);
        }

        if (!Array.isArray(rawDispatches) || rawDispatches.length === 0) {
          console.error("Dispatches must be a non-empty JSON array of requests.");
          process.exit(1);
        }

        const dispatches: any[] = [];
        for (const item of rawDispatches) {
          if (!item.agentId || !item.task) {
            console.error("Each dispatch must specify 'agentId' and 'task'.");
            process.exit(1);
          }
          if (!isAgentId(item.agentId)) {
            console.error(`Unknown agent: ${item.agentId}. Available: ${MANIFEST_AGENTS.join(", ")}`);
            process.exit(1);
          }
          dispatches.push(item);
        }

        try {
          const result = await dispatchAgentsParallel(
            projectRoot,
            dispatches,
            { skillsRoot: resolveSkillsRoot(), noLlm: options.llm === false }
          );

          if (result.success) {
            console.log("Parallel dispatches completed successfully!");
            if (result.mergeResult) {
              console.log(`Merged files: [${result.mergeResult.mergedFiles.join(", ")}]`);
              if (result.mergeResult.deletedFiles.length > 0) {
                console.log(`Deleted files: [${result.mergeResult.deletedFiles.join(", ")}]`);
              }
            }
            process.exit(0);
          } else {
            console.error(`Parallel dispatches failed: ${result.error}`);
            if (result.mergeResult && result.mergeResult.conflicts.length > 0) {
              console.error(`Conflicting files: [${result.mergeResult.conflicts.join(", ")}]`);
            }
            process.exit(1);
          }
        } catch (err: any) {
          if (err instanceof Error && err.message.startsWith("exit:")) {
            throw err;
          }
          console.error(err instanceof Error ? err.message : String(err));
          process.exit(1);
        }
      }
    );
}

