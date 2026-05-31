import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

const ToolEntry = z.object({
  name: z.string(),
  kind: z.string(),
  script: z.string(),
  purpose: z.string(),
  safety_policy: z
    .object({
      network: z.string(),
      writes_artifacts: z.boolean(),
      reads_secrets: z.boolean(),
    })
    .passthrough(),
});

const Registry = z.object({
  schema_version: z.string(),
  tools: z.array(ToolEntry),
});

export type PluginTool = z.infer<typeof ToolEntry>;

export function loadPluginTools(skillsRoot: string) {
  const path = join(skillsRoot, ".system", "references", "plugin-tools.json");
  const raw = JSON.parse(readFileSync(path, "utf8"));
  return Registry.parse(raw);
}
