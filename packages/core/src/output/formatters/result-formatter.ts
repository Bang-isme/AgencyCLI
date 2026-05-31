import type { OutputResult, OutputEngineConfig } from "../output-types.js";

export function formatResult(
  data: OutputResult,
  config: OutputEngineConfig,
): string {
  if (config.surface === "json") {
    return JSON.stringify({ type: "result", ...data });
  }

  const lines: string[] = [];

  if (data.title) {
    lines.push(data.title);
  }

  if (data.entries.length === 0) return lines.join("\n");

  const maxKeyLen = Math.max(...data.entries.map((e) => e.key.length));

  for (const entry of data.entries) {
    const paddedKey = entry.key.padEnd(maxKeyLen);
    lines.push(`  ${paddedKey}  ${entry.value}`);
  }

  return lines.join("\n");
}
