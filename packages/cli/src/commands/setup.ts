import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import {
  buildIndexAsync,
  incrementalUpdateAsync,
  resolveSkillsRoot,
  writeIndex,
  buildKnowledgeGraph,
} from "@agency/core";
import { resolveProjectRoot } from "../resolve-project.js";
import { out, handleError } from "../utils.js";

function configHasLlmKey(configPath: string): boolean {
  if (!existsSync(configPath)) return false;
  try {
    const raw = JSON.parse(readFileSync(configPath, "utf8")) as {
      providers?: Record<string, { apiKey?: string }>;
    };
    for (const profile of Object.values(raw.providers ?? {})) {
      const key = profile?.apiKey?.trim();
      if (key && key.length > 2) return true;
    }
  } catch {
    return false;
  }
  return false;
}

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

        const hasKey = configHasLlmKey(configPath);

        out.phase("setup completion", {
          project: projectRoot,
          indexedFiles: String(index.files.length),
          skillsPack: skillsRoot,
          configPath: configPath + (configCreated ? " (created template)" : ""),
          llmReady: hasKey ? "yes" : "no",
        });

        if (options.json) {
          out.json({
            project: projectRoot,
            files: index.files.length,
            skills: skillsRoot,
            config: configPath,
            llmReady: hasKey,
          });
        }
      } catch (err) {
        handleError(err, "setup failed");
      }
    });
}
