import { Command } from "commander";
import { execa } from "execa";
import { getGitSummary, getWorkspaceRoot } from "@agency/core";
import { out, handleError, writeProcessOutput } from "../utils.js";

export function registerGit(program: Command) {
  const git = program
    .command("git")
    .description("Git repository intelligence");

  git
    .command("summary")
    .description("Summarize branch, working tree, and recent commits")
    .option("--project-root <path>", "Project root directory")
    .action(async (options: { projectRoot?: string }) => {
      try {
        const projectRoot =
          options.projectRoot ?? getWorkspaceRoot(process.cwd());
        const summary = await getGitSummary(projectRoot);
        console.log(JSON.stringify(summary, null, 2));
      } catch (err) {
        handleError(err, "git summary failed");
      }
    });

  git
    .command("pr")
    .description("GitHub pull request status or create helper")
    .option("--project-root <path>", "Project root directory")
    .option("--create", "Print guidance to create a PR with gh")
    .action(async (options: { projectRoot?: string; create?: boolean }) => {
      try {
        const projectRoot =
          options.projectRoot ?? getWorkspaceRoot(process.cwd());
        const summary = await getGitSummary(projectRoot);

        if (!summary.ghAvailable) {
          out.failure({
            title: "GitHub CLI unavailable",
            consequence: "the `gh` command was not found on PATH",
            recovery: "install it from https://cli.github.com/",
          });
          process.exit(1);
        }

        if (options.create) {
          console.log("Create a pull request with: gh pr create");
          return;
        }

        const result = await execa("gh", ["pr", "status"], {
          cwd: projectRoot,
          reject: false,
        });
        writeProcessOutput(result.stdout, result.stderr);
        process.exit(result.exitCode === 0 ? 0 : 1);
      } catch (err) {
        handleError(err, "git pr failed");
      }
    });
}
