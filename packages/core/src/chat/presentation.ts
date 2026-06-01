import type { ChatTurnResult } from "./orchestrator.js";
import { buildSuggestedCommands } from "./route-presentation.js";
import type { RouteResult } from "../router/model-router.js";
import { JSONRepairEngine } from "@agency/tooling";


export type ChatOutputSurface = "human" | "json";

export interface RouteChip {
  label: string;
  value: string;
}

export interface PresentationTurn {
  body: string;
  chips: RouteChip[];
  suggestions: string[];
  cacheHint?: string;
}

export function routeToChips(route: RouteResult): RouteChip[] {
  const chips: RouteChip[] = [
    { label: "intent", value: route.intent },
    { label: "workflow", value: route.workflow },
    { label: "provider", value: route.provider },
  ];
  if (route.suggested_agent) {
    chips.push({ label: "agent", value: route.suggested_agent });
  }
  if (route.skills.length > 0) {
    chips.push({ label: "skills", value: route.skills.join(", ") });
  }
  for (const w of route.warnings) {
    chips.push({ label: "warn", value: w });
  }
  return chips;
}

function stripSuggestedCommandsBlock(
  text: string,
  known?: string[]
): { text: string; suggestions: string[] } {
  const marker = "\nSuggested commands:";
  const idx = text.indexOf(marker);
  if (idx === -1) {
    return { text, suggestions: known ?? [] };
  }
  const head = text.slice(0, idx).trimEnd();
  const tail = text.slice(idx + marker.length);
  const fromText = tail
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map((l) => l.replace(/^\s{2}/, ""));
  const suggestions = known?.length ? known : fromText;
  return { text: head, suggestions };
}

function stripRouteSummaryLine(text: string, routeSummary?: string): string {
  if (!routeSummary?.trim()) return text;
  const lines = text.split("\n");
  if (lines[0]?.trim() === routeSummary.trim()) {
    return lines.slice(1).join("\n").trimStart();
  }
  return text;
}

function stripJsonBlock(text: string): string {
  const start = text.indexOf("{");
  if (start === -1) return text;

  let depth = 0;
  let end = -1;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end === -1) return text;

  const candidate = text.slice(start, end + 1);
  try {
    const jre = new JSONRepairEngine();
    const repaired = jre.repair(candidate);
    JSON.parse(repaired);
  } catch {
    return text;
  }

  const before = text.slice(0, start).trimEnd();
  const after = text.slice(end + 1).trimStart();
  return after ? `${before}\n${after}` : before;
}

function stripCacheHint(text: string): { text: string; cacheHint?: string } {
  const hint = "(route cache hit)";
  if (text.endsWith(hint)) {
    return { text: text.slice(0, -hint.length).trimEnd(), cacheHint: "cached" };
  }
  return { text };
}

export function parseAssistantContent(
  raw: string,
  opts?: {
    routeSummary?: string;
    suggestedCommands?: string[];
    route?: RouteResult;
  }
): PresentationTurn {
  let text = raw.trim();
  const { text: noHint, cacheHint } = stripCacheHint(text);
  text = noHint;

  text = stripRouteSummaryLine(text, opts?.routeSummary);
  text = stripJsonBlock(text);

  const { text: body, suggestions } = stripSuggestedCommandsBlock(
    text,
    opts?.suggestedCommands
  );

  const chips = opts?.route ? routeToChips(opts.route) : [];

  return {
    body: body.trim(),
    chips,
    suggestions,
    cacheHint,
  };
}

export function toPresentationTurn(result: ChatTurnResult): PresentationTurn {
  const parsed = parseAssistantContent(result.assistantText, {
    routeSummary: result.routeSummary,
    suggestedCommands: result.suggestedCommands,
    route: result.route,
  });

  const chips =
    parsed.chips.length > 0 ? parsed.chips : routeToChips(result.route);

  return {
    body: parsed.body,
    chips,
    suggestions: parsed.suggestions,
    cacheHint:
      parsed.cacheHint ?? (result.routeFromCache ? "cached" : undefined),
  };
}

export function formatChipsLine(chips: RouteChip[], cacheHint?: string): string {
  const parts = chips.map((c) => `${c.label} ${c.value}`);
  let line = parts.join("  ");
  if (cacheHint) line += `  · ${cacheHint}`;
  return line;
}

export function formatSuggestionsOnly(_suggestions: string[]): string {
  return "";
}

export function formatHumanChatOutput(turn: PresentationTurn): string {
  const lines: string[] = [];

  if (turn.chips.length > 0) {
    lines.push(formatChipsLine(turn.chips, turn.cacheHint));
  }
  if (turn.body) {
    if (lines.length > 0) lines.push("");
    lines.push(turn.body);
  }

  return lines.join("\n").trimEnd();
}

export interface FormattedChatOutput {
  stdout: string;
  meta: string[];
}

export function formatRouteForSurface(
  route: RouteResult,
  prompt: string,
  projectRoot: string,
  surface: ChatOutputSurface = "human"
): { stdout: string } {
  const suggestions = buildSuggestedCommands(route, projectRoot, prompt);

  if (surface === "json") {
    return {
      stdout: JSON.stringify(
        { route, suggestedCommands: suggestions },
        null,
        2
      ),
    };
  }

  const chips = routeToChips(route);
  const parts = [formatChipsLine(chips)];
  const tail = formatSuggestionsOnly(suggestions);
  if (tail) parts.push(tail);
  return { stdout: parts.join("\n").trimEnd() };
}

export function formatChatTurnForSurface(
  result: ChatTurnResult,
  surface: ChatOutputSurface = "human"
): FormattedChatOutput {
  const meta: string[] = [];
  if (result.routeFromCache) {
    meta.push("route cache hit");
  }
  meta.push(
    `budget=${result.budget} context_files=${result.contextFiles.length} route_only=${result.routeOnly}`
  );

  if (surface === "json") {
    return {
      stdout: JSON.stringify(
        {
          route: result.route,
          routeSummary: result.routeSummary,
          suggestedCommands: result.suggestedCommands,
          message: result.assistantText,
          routeOnly: result.routeOnly,
          budget: result.budget,
          contextFiles: result.contextFiles,
          routeFromCache: result.routeFromCache,
        },
        null,
        2
      ),
      meta,
    };
  }

  const turn = toPresentationTurn(result);
  return {
    stdout: formatHumanChatOutput(turn),
    meta,
  };
}
