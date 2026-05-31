import { Command } from "commander";
import { getWorkspaceRoot, loadKnowledgeGraph } from "@agency/core";
import { out, handleError } from "../utils.js";

export function registerGraph(program: Command) {
  program
    .command("graph")
    .description("Print workspace knowledge graph summary as JSON")
    .option("--project-root <path>", "Project root directory")
    .action((options: { projectRoot?: string }) => {
      try {
        const projectRoot =
          options.projectRoot ?? getWorkspaceRoot(process.cwd());
        const view = loadKnowledgeGraph(projectRoot);
        if (!view) {
          out.failure({
            title: "knowledge graph not found",
            consequence:
              "no graph at .agency/knowledge/knowledge-graph.json or .codex/knowledge/knowledge-graph.json",
            recovery: "run `agency index` to build the workspace index + graph",
          });
          process.exit(1);
        }
        console.log(JSON.stringify(view, null, 2));
      } catch (err) {
        handleError(err, "graph failed");
      }
    });
}
