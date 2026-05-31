import { Command } from "commander";
import { generateHandover } from "@agency/core";
import { resolveProjectRoot } from "../resolve-project.js";

export function registerHandover(program: Command) {
  program
    .command("handover")
    .description("Generate .agency/handover.md so a new session can resume with minimal context loss")
    .option("--project-root <path>", "Project root directory")
    .option("--print", "Print the handover to stdout instead of only writing the file")
    .action((options: { projectRoot?: string; print?: boolean }) => {
      const projectRoot = resolveProjectRoot(options.projectRoot);
      const { markdown, path } = generateHandover(projectRoot);
      if (options.print) {
        console.log(markdown);
      } else {
        console.log(`Handover written to ${path}`);
      }
    });
}
