import type { OutputPhase, OutputEngineConfig } from "../output-types.js";

export function formatPhase(
  data: OutputPhase,
  config: OutputEngineConfig,
): string {
  if (config.surface === "json") {
    return JSON.stringify({ type: "phase", ...data });
  }

  const metaStr = data.meta
    ? "  " +
      Object.entries(data.meta)
        .map(([k, v]) => `${k}=${v}`)
        .join("  ")
    : "";

  return `\u27d0 ${data.label}${metaStr}`;
}
