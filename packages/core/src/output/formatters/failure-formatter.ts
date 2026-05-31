import type { OutputFailure, OutputEngineConfig } from "../output-types.js";

export function formatFailure(
  data: OutputFailure,
  config: OutputEngineConfig,
): string {
  if (config.surface === "json") {
    return JSON.stringify({ type: "failure", ...data });
  }

  const lines: string[] = [];
  const rollback = data.rolledBack ? " \u00b7 rolled back" : "";

  lines.push(`${data.title}${rollback}`);

  if (data.consequence) {
    lines.push(`  ${data.consequence}`);
  }

  if (data.recovery) {
    lines.push(`  recovery: ${data.recovery}`);
  }

  if (data.recoveryCommand) {
    lines.push(`    $ ${data.recoveryCommand}`);
  }

  return lines.join("\n");
}
