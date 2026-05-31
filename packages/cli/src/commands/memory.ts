import { Command } from "commander";
import {
  ApprovalRequiredError,
  getWorkspaceRoot,
  resolveSkillsRoot,
  runMemoryScript,
} from "@agency/core";
import { writeProcessOutput, exitFromResult } from "../utils.js";

export function registerMemory(program: Command) {
  const memory = program
    .command("memory")
    .description("Project memory bridge (project-memory scripts)");

  memory
    .command("status")
    .description("Validate .agency/knowledge or .codex/knowledge artifacts for staleness and coherence")
    .option("--project-root <path>", "Project root directory")
    .action(async (options: { projectRoot?: string }) => {
      const projectRoot = options.projectRoot ?? getWorkspaceRoot(process.cwd());
      const skillsRoot = resolveSkillsRoot();
      const { exitCode, stdout, stderr } = await runMemoryScript(
        skillsRoot,
        "status",
        ["--project-root", projectRoot, "--format", "json"]
      );
      writeProcessOutput(stdout, stderr);
      exitFromResult(exitCode);
    });

  memory
    .command("build")
    .description("Build .agency/knowledge or .codex/knowledge index from project context sources")
    .option("--project-root <path>", "Project root directory")
    .option("--yes", "Approve artifact writes")
    .action(async (options: { projectRoot?: string; yes?: boolean }) => {
      const projectRoot = options.projectRoot ?? getWorkspaceRoot(process.cwd());
      const skillsRoot = resolveSkillsRoot();
      try {
        const { exitCode, stdout, stderr } = await runMemoryScript(
          skillsRoot,
          "build",
          ["--project-root", projectRoot, "--format", "json"],
          { yes: options.yes }
        );
        writeProcessOutput(stdout, stderr);
        exitFromResult(exitCode);
      } catch (err) {
        if (err instanceof ApprovalRequiredError) {
          console.error(err.message);
          process.exit(1);
        }
        throw err;
      }
    });

  memory
    .command("genome")
    .description("Generate layered project context documentation")
    .option("--project-root <path>", "Project root directory")
    .option("--depth <depth>", "Scan depth mode", "auto")
    .action(async (options: { projectRoot?: string; depth?: string }) => {
      const projectRoot = options.projectRoot ?? getWorkspaceRoot(process.cwd());
      const skillsRoot = resolveSkillsRoot();
      const { exitCode, stdout, stderr } = await runMemoryScript(
        skillsRoot,
        "genome",
        [
          "--project-root",
          projectRoot,
          "--depth",
          options.depth ?? "auto",
          "--format",
          "json",
        ]
      );
      writeProcessOutput(stdout, stderr);
      exitFromResult(exitCode);
    });
}
