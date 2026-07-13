import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import {
  buildIndexAsync,
  incrementalUpdateAsync,
  resolveSkillsRoot,
  writeIndex,
  buildKnowledgeGraph,
  getWorkspaceReadiness,
} from "@agency/core";
import { resolveProjectRoot } from "../resolve-project.js";
import { out, handleError } from "../utils.js";

const CONFIG_EXAMPLE = `{
  "defaultProvider": "openrouter",
  "providers": {
    "openrouter": {
      "apiKey": "\${OPENROUTER_API_KEY}"
    }
  }
}
`;

export function registerSetup(program: Command) {
  program
    .command("setup")
    .description("One-shot daily-use bootstrap: index project + check skills + config hint")
    .option("--project-root <path>", "Project root to index")
    .option("--force-index", "Rebuild workspace index from scratch")
    .option("--json", "Machine-readable JSON output")
    .option("--quiet", "Suppress routing meta on stderr")
    .action(async (options: { projectRoot?: string; forceIndex?: boolean; json?: boolean; quiet?: boolean }) => {
      if (options.json) {
        out.configure({ surface: "json", quiet: options.quiet });
      } else {
        out.configure({ surface: "human", quiet: options.quiet });
      }

      try {
        const projectRoot = resolveProjectRoot(options.projectRoot);
        const index = options.forceIndex
          ? await buildIndexAsync(projectRoot)
          : await incrementalUpdateAsync(projectRoot);
        writeIndex(projectRoot, index);

        await buildKnowledgeGraph(projectRoot);

        let skillsRoot: string;
        try {
          skillsRoot = resolveSkillsRoot();
        } catch (err) {
          skillsRoot = "(not found)";
        }

        const configDir = join(homedir(), ".agency");
        const configPath = join(configDir, "config.json");
        let configCreated = false;
        if (!existsSync(configPath)) {
          mkdirSync(configDir, { recursive: true });
          writeFileSync(configPath, CONFIG_EXAMPLE, "utf8");
          configCreated = true;
        }

        const readiness = await getWorkspaceReadiness(projectRoot);
        const provider = readiness.find((check) => check.id === "provider");

        out.phase("setup completion", {
          project: projectRoot,
          indexedFiles: String(index.files.length),
          skillsPack: skillsRoot,
          configPath: configPath + (configCreated ? " (created template)" : ""),
          provider: provider?.detail ?? "Unknown",
        });

        if (options.json) {
          out.json({
            project: projectRoot,
            files: index.files.length,
            skills: skillsRoot,
            config: configPath,
            readiness,
          });
        }
      } catch (err) {
        handleError(err, "setup failed");
      }
    });
}
