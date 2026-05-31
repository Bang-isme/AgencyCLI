import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { saveAgencyConfig, configFilePath, type AgencyConfig } from "@agency/core";
import { out, handleError } from "../utils.js";

type RawConfig = Record<string, unknown>;

function readRawConfig(path: string): RawConfig {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as RawConfig;
  } catch {
    return {};
  }
}

/** Mask a secret while keeping `${ENV_VAR}` placeholders visible (they hold no secret). */
function maskKey(value: string): string {
  if (value.startsWith("${")) return value;
  if (value.length <= 4) return "****";
  return `****${value.slice(-4)}`;
}

function maskConfig(cfg: RawConfig): RawConfig {
  const clone = JSON.parse(JSON.stringify(cfg)) as RawConfig;
  const providers = clone.providers as Record<string, Record<string, unknown>> | undefined;
  if (providers && typeof providers === "object") {
    for (const id of Object.keys(providers)) {
      const p = providers[id];
      if (p && typeof p.apiKey === "string") p.apiKey = maskKey(p.apiKey);
    }
  }
  return clone;
}

/** Interpret booleans/integers; everything else (incl. `${ENV}`) stays a string. */
function parseValue(raw: string): unknown {
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (/^-?\d+$/.test(raw)) return Number(raw);
  return raw;
}

function getPath(obj: RawConfig, path: string): unknown {
  let cur: unknown = obj;
  for (const part of path.split(".")) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

function setPath(obj: RawConfig, path: string, value: unknown): void {
  const parts = path.split(".");
  let cur = obj as Record<string, unknown>;
  for (let i = 0; i < parts.length - 1; i++) {
    const k = parts[i]!;
    if (cur[k] == null || typeof cur[k] !== "object") cur[k] = {};
    cur = cur[k] as Record<string, unknown>;
  }
  cur[parts[parts.length - 1]!] = value;
}

function unsetPath(obj: RawConfig, path: string): boolean {
  const parts = path.split(".");
  let cur = obj as Record<string, unknown>;
  for (let i = 0; i < parts.length - 1; i++) {
    const k = parts[i]!;
    if (cur[k] == null || typeof cur[k] !== "object") return false;
    cur = cur[k] as Record<string, unknown>;
  }
  const last = parts[parts.length - 1]!;
  if (last in cur) {
    delete cur[last];
    return true;
  }
  return false;
}

const DEFAULT_CONFIG = `{
  "defaultProvider": "openrouter",
  "providers": {
    "openrouter": {
      "apiKey": "\${OPENROUTER_API_KEY}"
    },
    "anthropic": {
      "apiKey": "\${ANTHROPIC_API_KEY}"
    },
    "local": {
      "baseUrl": "http://127.0.0.1:11434/v1",
      "model": "llama3"
    }
  }
}
`;

function exampleConfigPath(): string {
  const repoRoot = join(fileURLToPath(new URL(".", import.meta.url)), "../../../..");
  return join(repoRoot, "scripts", "config.example.json");
}

export function registerConfig(program: Command) {
  const config = program
    .command("config")
    .description("Manage ~/.agency/config.json (LLM providers)");

  config
    .command("init")
    .description("Create ~/.agency/config.json from template if missing")
    .option("--force", "Overwrite existing config")
    .option("--json", "Machine-readable JSON output")
    .option("--quiet", "Suppress routing meta on stderr")
    .action((options: { force?: boolean; json?: boolean; quiet?: boolean }) => {
      if (options.json) {
        out.configure({ surface: "json", quiet: options.quiet });
      } else {
        out.configure({ surface: "human", quiet: options.quiet });
      }

      try {
        const dir = join(homedir(), ".agency");
        const path = join(dir, "config.json");
        if (existsSync(path) && !options.force) {
          out.failure({
            title: "config exists",
            consequence: `configuration file already present at ${path}`,
            recovery: "run with --force to overwrite",
          });
          return;
        }
        mkdirSync(dir, { recursive: true });
        const example = exampleConfigPath();
        const body = existsSync(example)
          ? readFileSync(example, "utf8")
          : DEFAULT_CONFIG;
        writeFileSync(path, body, "utf8");

        out.phase("config initialized", {
          path,
        });

        if (options.json) {
          out.json({ path, status: "initialized" });
        }
      } catch (err) {
        handleError(err, "config init failed");
      }
    });

  config
    .command("path")
    .description("Print config file path")
    .option("--json", "Machine-readable JSON output")
    .option("--quiet", "Suppress routing meta on stderr")
    .action((options: { json?: boolean; quiet?: boolean }) => {
      if (options.json) {
        out.configure({ surface: "json", quiet: options.quiet });
      } else {
        out.configure({ surface: "human", quiet: options.quiet });
      }

      const path = join(homedir(), ".agency", "config.json");
      if (options.json) {
        out.json({ path });
      } else {
        out.passthrough(path);
      }
    });

  config
    .command("show")
    .description("Print the current config (API keys masked)")
    .option("--json", "Machine-readable JSON output")
    .option("--quiet", "Suppress routing meta on stderr")
    .action((options: { json?: boolean; quiet?: boolean }) => {
      out.configure({
        surface: options.json ? "json" : "human",
        quiet: options.quiet,
      });
      const path = configFilePath();
      if (!existsSync(path)) {
        out.failure({
          title: "no config",
          consequence: `no config file at ${path}`,
          recovery: "run `agency config init`",
        });
        return;
      }
      const masked = maskConfig(readRawConfig(path));
      if (options.json) {
        out.json(masked);
      } else {
        out.passthrough(JSON.stringify(masked, null, 2));
      }
    });

  config
    .command("get")
    .description("Print a single config value by dotted key")
    .argument("<key>", "Dotted key, e.g. defaultProvider or providers.openai.model")
    .option("--json", "Machine-readable JSON output")
    .option("--quiet", "Suppress routing meta on stderr")
    .action((key: string, options: { json?: boolean; quiet?: boolean }) => {
      out.configure({
        surface: options.json ? "json" : "human",
        quiet: options.quiet,
      });
      const raw = readRawConfig(configFilePath());
      let value = getPath(raw, key);
      if (key.endsWith("apiKey") && typeof value === "string") {
        value = maskKey(value);
      }
      if (value === undefined) {
        out.failure({
          title: "not set",
          consequence: `${key} is not set`,
          recovery: "list current keys with `agency config show`",
        });
        return;
      }
      if (options.json) {
        out.json({ [key]: value });
      } else {
        out.passthrough(
          typeof value === "string" ? value : JSON.stringify(value, null, 2)
        );
      }
    });

  config
    .command("set")
    .description("Set a config value by dotted key (booleans/integers are coerced)")
    .argument("<key>", "Dotted key, e.g. defaultProvider or providers.openai.apiKey")
    .argument("<value>", "Value (use ${ENV_VAR} for secrets to avoid plaintext keys)")
    .option("--json", "Machine-readable JSON output")
    .option("--quiet", "Suppress routing meta on stderr")
    .action(
      (key: string, value: string, options: { json?: boolean; quiet?: boolean }) => {
        out.configure({
          surface: options.json ? "json" : "human",
          quiet: options.quiet,
        });
        try {
          const path = configFilePath();
          const raw = readRawConfig(path);
          const parsed = parseValue(value);
          setPath(raw, key, parsed);
          saveAgencyConfig(raw as unknown as AgencyConfig, path);

          const shown =
            key.endsWith("apiKey") && typeof parsed === "string"
              ? maskKey(parsed)
              : String(parsed);
          if (key.endsWith("apiKey") && !value.startsWith("${")) {
            out.meta(
              "tip: store secrets as ${ENV_VAR} placeholders instead of raw keys (resolved from the environment at runtime)"
            );
          }
          out.phase("config updated", { [key]: shown });
          if (options.json) out.json({ key, status: "set" });
        } catch (err) {
          handleError(err, "config set failed");
        }
      }
    );

  config
    .command("unset")
    .description("Remove a config value by dotted key")
    .argument("<key>", "Dotted key to remove")
    .option("--json", "Machine-readable JSON output")
    .option("--quiet", "Suppress routing meta on stderr")
    .action((key: string, options: { json?: boolean; quiet?: boolean }) => {
      out.configure({
        surface: options.json ? "json" : "human",
        quiet: options.quiet,
      });
      try {
        const path = configFilePath();
        const raw = readRawConfig(path);
        if (!unsetPath(raw, key)) {
          out.failure({
            title: "not set",
            consequence: `${key} was not present`,
            recovery: "nothing to remove",
          });
          return;
        }
        saveAgencyConfig(raw as unknown as AgencyConfig, path);
        out.phase("config key removed", { key });
        if (options.json) out.json({ key, status: "unset" });
      } catch (err) {
        handleError(err, "config unset failed");
      }
    });
}
