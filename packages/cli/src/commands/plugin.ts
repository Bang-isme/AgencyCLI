import { Command } from "commander";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { resolveSkillsRoot } from "@agency/core";
import {
  loadPluginTools,
  runBuiltinScript,
  runTool,
} from "@agency/skills-bridge";
import { handleError } from "../utils.js";

interface PluginToolsSchemaMeta {
  schema_version?: string;
  tools?: unknown[];
}

function pluginSchemaPath(skillsRoot: string): string {
  return join(skillsRoot, ".system", "references", "plugin-tools.schema.json");
}

function findValidateTool(
  tools: ReturnType<typeof loadPluginTools>["tools"]
): (typeof tools)[number] | undefined {
  return tools.find(
    (t) =>
      t.name === "plugin_validate" ||
      t.script.endsWith("validate_codex_plugin.py")
  );
}

function validateAgainstSchema(
  skillsRoot: string,
  registry: ReturnType<typeof loadPluginTools>
): void {
  const schemaPath = pluginSchemaPath(skillsRoot);
  if (!existsSync(schemaPath)) return;

  const meta = JSON.parse(readFileSync(schemaPath, "utf8")) as PluginToolsSchemaMeta;
  if (meta.schema_version !== registry.schema_version) {
    console.warn(
      `Warning: registry schema_version "${registry.schema_version}" differs from schema file "${meta.schema_version}"`
    );
  }
  if (
    typeof meta.tools === "object" &&
    Array.isArray(meta.tools) &&
    meta.tools.length !== registry.tools.length
  ) {
    console.warn(
      `Warning: registry has ${registry.tools.length} tools; schema lists ${meta.tools.length}`
    );
  }
}

async function runPluginValidate(skillsRoot: string): Promise<number> {
  const registry = loadPluginTools(skillsRoot);
  const validateTool = findValidateTool(registry.tools);
  const pluginRoot = basename(skillsRoot) === "skills" ? dirname(skillsRoot) : skillsRoot;
  const argv = ["--plugin-root", pluginRoot];

  const { exitCode, stdout, stderr } = validateTool
    ? await runTool(skillsRoot, validateTool.name, argv, { yes: true })
    : await runBuiltinScript(skillsRoot, "plugin_validate", argv);

  if (stdout) process.stdout.write(stdout + (stdout.endsWith("\n") ? "" : "\n"));
  if (stderr) process.stderr.write(stderr);
  return exitCode === 0 ? 0 : 1;
}

export function registerPlugin(program: Command) {
  const plugin = program
    .command("plugin")
    .description("Plugin SDK — validate pack and export plugin-tools.json");

  plugin
    .command("validate")
    .description("Run Codex plugin validation script against the skills pack")
    .action(async () => {
      try {
        const skillsRoot = resolveSkillsRoot();
        process.exit(await runPluginValidate(skillsRoot));
      } catch (err) {
        handleError(err, "plugin validate failed");
      }
    });

  plugin
    .command("tools")
    .description("Export plugin-tools.json registry as JSON")
    .option("-o, --output <file>", "Write JSON to file instead of stdout")
    .action((opts: { output?: string }) => {
      try {
        const skillsRoot = resolveSkillsRoot();
        const registry = loadPluginTools(skillsRoot);
        validateAgainstSchema(skillsRoot, registry);
        const json = JSON.stringify(registry, null, 2);
        if (opts.output) {
          writeFileSync(opts.output, json + "\n", "utf8");
        } else {
          process.stdout.write(json + "\n");
        }
      } catch (err) {
        handleError(err, "plugin tools failed");
      }
    });

  plugin
    .command("schema")
    .description("Print path to plugin-tools.schema.json")
    .action(() => {
      try {
        const skillsRoot = resolveSkillsRoot();
        console.log(pluginSchemaPath(skillsRoot));
      } catch (err) {
        handleError(err, "plugin schema failed");
      }
    });
}
