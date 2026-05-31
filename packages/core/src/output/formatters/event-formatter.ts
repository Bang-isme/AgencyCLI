import type { OutputEvent, OutputEngineConfig } from "../output-types.js";

export function formatEvent(
  event: OutputEvent,
  config: OutputEngineConfig,
): string {
  if (config.surface === "json") {
    return JSON.stringify({ type: "event", ...event });
  }

  const source = event.source ? `[${event.source}]` : "";
  const badge = event.confidence ? ` (${event.confidence})` : "";

  switch (event.tier ?? "secondary") {
    case "primary":
      return `${source}\n${event.message}${badge}`;
    case "secondary":
      return `${source} ${event.message}${badge}`;
    case "tertiary":
      return `  ${event.message}${badge}`;
    case "background":
      return `  \u00b7 ${event.message}`;
  }
}
