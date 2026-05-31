import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

const mcpServerConfigSchema = z.object({
  command: z.string(),
  args: z.array(z.string()).default([]),
  env: z.record(z.string(), z.string()).optional(),
});

const mcpConfigSchema = z.object({
  mcpServers: z.record(z.string(), mcpServerConfigSchema).optional().default({}),
});

export interface McpServerEnvKey {
  key: string;
  configured: boolean;
  resolvedValue?: string;
}

export interface McpServerStatus {
  name: string;
  command: string;
  args?: string[];
  configured: boolean;
  keys: McpServerEnvKey[];
  sourcePath: string;
}

function resolveEnvValue(val: string): string {
  // Resolve both ${VAR} and %VAR%
  let resolved = val.replace(/\$\{([a-zA-Z0-9_]+)\}/g, (_, name) => process.env[name] ?? "");
  resolved = resolved.replace(/%([a-zA-Z0-9_]+)%/g, (_, name) => process.env[name] ?? "");
  return resolved;
}

export function loadMcpConfigs(projectRoot: string): McpServerStatus[] {
  const paths = [
    join(projectRoot, ".agency", "mcp.json"),
    join(homedir(), ".agency", "mcp.json"),
  ];

  const serversMap = new Map<string, McpServerStatus>();

  for (const path of paths) {
    if (!existsSync(path)) continue;

    try {
      const content = readFileSync(path, "utf8");
      const parsed = JSON.parse(content);
      const validated = mcpConfigSchema.safeParse(parsed);
      if (!validated.success) continue;

      const mcpServers = validated.data.mcpServers;
      for (const [name, config] of Object.entries(mcpServers)) {
        // If we already saw this server in a higher-priority file (e.g. project-local is higher priority than global), skip
        if (serversMap.has(name)) continue;

        const keys: McpServerEnvKey[] = [];
        let configured = true;

        if (config.env) {
          for (const [envKey, rawValue] of Object.entries(config.env)) {
            const resolved = resolveEnvValue(rawValue);
            const isConfigured = resolved.trim().length > 0;
            if (!isConfigured) {
              configured = false;
            }
            keys.push({
              key: envKey,
              configured: isConfigured,
              resolvedValue: isConfigured ? resolved : undefined,
            });
          }
        }

        serversMap.set(name, {
          name,
          command: config.command,
          args: config.args,
          configured,
          keys,
          sourcePath: path,
        });
      }
    } catch {
      // Ignore invalid files and continue to next path
    }
  }

  return Array.from(serversMap.values());
}
