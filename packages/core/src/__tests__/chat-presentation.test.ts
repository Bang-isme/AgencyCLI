import { describe, expect, it } from "vitest";
import {
  formatChatTurnForSurface,
  formatChipsLine,
  toPresentationTurn,
} from "../chat/presentation.js";
import type { ChatTurnResult } from "../chat/orchestrator.js";
import type { RouteResult } from "../router/model-router.js";

const route: RouteResult = {
  intent: "other",
  suggested_agent: null,
  workflow: "plan",
  skills: [],
  provider: "openrouter",
  warnings: ["low_confidence_fallback"],
};

function makeResult(assistantText: string): ChatTurnResult {
  return {
    route,
    routeSummary:
      "intent: other · workflow: plan · provider: openrouter · warnings: low_confidence_fallback",
    assistantText,
    suggestedCommands: [
      "agency workflow run plan --project-root .",
      'agency route "da"',
    ],
    routeOnly: true,
    budget: "normal",
    contextFiles: [],
    routeFromCache: false,
  };
}

describe("toPresentationTurn", () => {
  it("removes JSON and suggested-command blocks from assistant text", () => {
    const raw = [
      "intent: other · workflow: plan · provider: openrouter · warnings: low_confidence_fallback",
      "",
      JSON.stringify(route, null, 2),
      "",
      "Suggested commands:",
      "  agency workflow run plan --project-root .",
    ].join("\n");

    const turn = toPresentationTurn(makeResult(raw));
    expect(turn.body).toBe("");
    expect(turn.chips.some((c) => c.label === "workflow")).toBe(true);
    expect(turn.suggestions).toHaveLength(2);
  });
});

describe("formatChatTurnForSurface", () => {
  it("human surface prints chips, body, and numbered next steps without JSON", () => {
    const result = makeResult("Plan: refactor auth module in three steps.");
    const { stdout } = formatChatTurnForSurface(result, "human");

    expect(stdout).toContain("intent");
    expect(stdout).toContain("plan");
    expect(stdout).toContain("Plan: refactor auth");
    expect(stdout).not.toContain("Next");
    expect(stdout).not.toContain("1. agency workflow");
    expect(stdout).not.toMatch(/\{\s*"intent"/);
    expect(stdout).toContain("warn");
  });

  it("json surface returns structured payload", () => {
    const result = makeResult("hello");
    const { stdout } = formatChatTurnForSurface(result, "json");
    const parsed = JSON.parse(stdout) as { route: RouteResult };
    expect(parsed.route.intent).toBe("other");
  });
});

describe("formatChipsLine", () => {
  it("joins chip labels for terminal display", () => {
    const line = formatChipsLine([
      { label: "intent", value: "debug" },
      { label: "workflow", value: "fix" },
    ]);
    expect(line).toContain("intent debug");
    expect(line).toContain("workflow fix");
  });
});
