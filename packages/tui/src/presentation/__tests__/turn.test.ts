import { describe, expect, it } from "vitest";
import { parseAssistantContent, toPresentationTurn } from "../turn.js";
import type { RouteResult } from "@agency/core";

const route: RouteResult = {
  intent: "other",
  workflow: "plan",
  provider: "openrouter",
  skills: [],
  warnings: ["low_confidence_fallback"],
  suggested_agent: null,
};

describe("parseAssistantContent", () => {
  it("strips route summary, JSON block, and suggested commands", () => {
    const raw = [
      "intent: other · workflow: plan · provider: openrouter · warnings: low_confidence_fallback",
      "",
      JSON.stringify(route, null, 2),
      "",
      "Suggested commands:",
      "  agency workflow run plan --project-root .",
      "  agency route \"da\"",
    ].join("\n");

    const parsed = parseAssistantContent(raw, {
      route,
      routeSummary:
        "intent: other · workflow: plan · provider: openrouter · warnings: low_confidence_fallback",
      suggestedCommands: [
        "agency workflow run plan --project-root .",
        'agency route "da"',
      ],
    });

    expect(parsed.body).toBe("");
    expect(parsed.suggestions).toHaveLength(2);
    expect(parsed.chips).toEqual(
      expect.arrayContaining([
        { label: "intent", value: "other" },
        { label: "workflow", value: "plan" },
      ])
    );
  });

  it("keeps LLM prose and removes trailing command block", () => {
    const raw = [
      "Here is a concise plan for your task.",
      "",
      "Suggested commands:",
      "  agency workflow run plan --project-root .",
    ].join("\n");

    const parsed = parseAssistantContent(raw, {
      suggestedCommands: ["agency workflow run plan --project-root ."],
    });

    expect(parsed.body).toBe("Here is a concise plan for your task.");
    expect(parsed.suggestions).toHaveLength(1);
  });
});

describe("toPresentationTurn", () => {
  it("builds chips from route without duplicating JSON in body", () => {
    const turn = toPresentationTurn({
      route,
      routeSummary: formatSummary(route),
      assistantText: [
        formatSummary(route),
        "",
        JSON.stringify(route, null, 2),
        "",
        "Suggested commands:",
        "  agency workflow run plan --project-root .",
      ].join("\n"),
      suggestedCommands: ["agency workflow run plan --project-root ."],
      routeOnly: true,
      budget: "normal",
      contextFiles: [],
      routeFromCache: true,
    });

    expect(turn.body).toBe("");
    expect(turn.chips.some((c) => c.label === "intent")).toBe(true);
    expect(turn.suggestions[0]).toContain("workflow run plan");
    expect(turn.cacheHint).toBe("cached");
  });
});

function formatSummary(r: RouteResult): string {
  return `intent: ${r.intent} · workflow: ${r.workflow} · provider: ${r.provider} · warnings: ${r.warnings.join("; ")}`;
}
