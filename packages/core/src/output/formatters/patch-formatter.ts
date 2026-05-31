import type { OutputPatch, OutputEngineConfig } from "../output-types.js";

export function formatPatch(
  data: OutputPatch,
  config: OutputEngineConfig,
): string {
  if (config.surface === "json") {
    return JSON.stringify({ type: "patch", ...data });
  }

  const lines: string[] = [];

  if (data.title) {
    lines.push(data.title);
  }

  for (const change of data.changes) {
    const file = change.file ? `  ${change.file}` : "";
    lines.push(`[${change.action}] ${change.target}${file}`);
  }

  if (data.hiddenCount && data.hiddenCount > 0) {
    lines.push(`[+${data.hiddenCount} changes hidden]`);
  }

  const trustParts: string[] = [];
  if (data.risk) trustParts.push(`risk: ${data.risk}`);
  if (data.confidence) trustParts.push(`confidence: ${data.confidence}`);
  if (data.validation) trustParts.push(`validation: ${data.validation}`);
  if (trustParts.length > 0) {
    lines.push("");
    lines.push(trustParts.join("  \u00b7  "));
  }

  return lines.join("\n");
}
