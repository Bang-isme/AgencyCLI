import { Command } from "commander";
import {
  formatRouteForSurface,
  getWorkspaceRoot,
  resolveSkillsRoot,
  routeUserPrompt,
} from "@agency/core";
import { out, handleError } from "../utils.js";

export function registerRoute(program: Command) {
  program
    .command("route")
    .argument("<prompt>", "Prompt to route")
    .description("Route prompt via skills pack (human-readable by default)")
    .option("--project-root <path>", "Project root for routing weights")
    .option("--json", "Machine-readable JSON")
    .action(async (prompt: string, options: { projectRoot?: string; json?: boolean }) => {
      out.configure({ surface: options.json ? "json" : "human" });
      try {
        const skillsRoot = resolveSkillsRoot();
        const projectRoot =
          options.projectRoot ?? getWorkspaceRoot(process.cwd());
        const result = await routeUserPrompt(skillsRoot, prompt, projectRoot);
        const surface = options.json ? "json" : "human";
        const { stdout } = formatRouteForSurface(
          result,
          prompt,
          projectRoot,
          surface
        );
        console.log(stdout);
      } catch (err) {
        handleError(err, "route failed");
      }
    });
}
