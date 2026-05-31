import { Command } from "commander";
import {
  buildIndexAsync,
  incrementalUpdateAsync,
  writeIndex,
  buildKnowledgeGraph,
} from "@agency/core";
import { resolveProjectRoot } from "../resolve-project.js";
import { handleError } from "../utils.js";

export function registerIndex(program: Command) {
  program
    .command("index")
    .description("Build or update the workspace file index (.agency/index.json)")
    .option("--project-root <path>", "Project root directory")
    .option("--force", "Rebuild the index from scratch")
    .action(async (options: { projectRoot?: string; force?: boolean }) => {
      try {
        const projectRoot = resolveProjectRoot(options.projectRoot);
        const index = options.force
          ? await buildIndexAsync(projectRoot)
          : await incrementalUpdateAsync(projectRoot);
        writeIndex(projectRoot, index);
        await buildKnowledgeGraph(projectRoot);
        console.log(`Indexed ${index.files.length} files and generated knowledge graph → ${projectRoot}`);
      } catch (err) {
        handleError(err, "index failed");
      }
    });
}
