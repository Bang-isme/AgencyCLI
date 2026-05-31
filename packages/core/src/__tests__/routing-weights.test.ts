import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import type { RouteResult } from "../router/model-router.js";
import {
  applyWeightsToRoute,
  loadWeights,
  recordFeedback,
  saveWeights,
  scoreIntentsDiscriminative,
  scoreIntentsFromPrompt,
  tokenize,
  weightsPath,
} from "../router/weights.js";

const baseRoute = (intent: string): RouteResult => ({
  intent,
  suggested_agent: null,
  workflow: "create",
  skills: [],
  provider: "anthropic",
  warnings: [],
});

describe("routing weights", () => {
  let projectRoot: string;

  afterEach(() => {
    if (projectRoot) rmSync(projectRoot, { recursive: true, force: true });
  });

  it("tokenize splits on non-alphanumeric", () => {
    expect(tokenize("Fix Auth-Bug!")).toEqual(["fix", "auth", "bug"]);
  });

  it("loadWeights returns null when file missing", () => {
    projectRoot = mkdtempSync(join(tmpdir(), "agency-weights-"));
    expect(loadWeights(projectRoot)).toBeNull();
  });

  it("saveWeights and loadWeights round-trip", () => {
    projectRoot = mkdtempSync(join(tmpdir(), "agency-weights-rt-"));
    const data = {
      version: 1 as const,
      signals: { debug: 2 },
      feedback: [{ prompt: "x", correctIntent: "debug", ts: "2020-01-01T00:00:00.000Z" }],
    };
    saveWeights(projectRoot, data);
    expect(existsSync(weightsPath(projectRoot))).toBe(true);
    expect(loadWeights(projectRoot)).toEqual(data);
  });

  it("recordFeedback bumps signals and appends feedback", () => {
    projectRoot = mkdtempSync(join(tmpdir(), "agency-weights-fb-"));
    const updated = recordFeedback(projectRoot, "fix login", "debug");
    expect(updated.signals["fix:debug"]).toBe(1);
    expect(updated.signals["login:debug"]).toBe(1);
    expect(updated.feedback).toHaveLength(1);
    expect(updated.feedback[0]?.prompt).toBe("fix login");
    expect(updated.feedback[0]?.correctIntent).toBe("debug");

    const again = recordFeedback(projectRoot, "auth issue", "debug");
    expect(again.signals["auth:debug"]).toBe(1);
    expect(again.signals["issue:debug"]).toBe(1);
    expect(again.feedback).toHaveLength(2);
  });

  it("scoreIntentsFromPrompt sums matching token weights with new format and legacy format", () => {
    // New format
    expect(
      scoreIntentsFromPrompt("fix security bug", { "security:review": 5, "debug:debug": 2 })
    ).toEqual({
      review: 5,
    });
    // Legacy format
    expect(
      scoreIntentsFromPrompt("fix security bug", { security: 5, debug: 2 })
    ).toEqual({
      security: 5,
    });
  });

  it("applyWeightsToRoute overrides when weighted intent scores higher than baseline", () => {
    const weights = {
      version: 1 as const,
      signals: { "debug:debug": 5, "other:other": 1 },
      feedback: [],
    };
    const result = applyWeightsToRoute(
      baseRoute("other"),
      "please debug this failure",
      weights
    );
    expect(result.intent).toBe("debug");
    expect(result.warnings.some((w) => w.includes("routing-weights"))).toBe(true);
  });

  it("applyWeightsToRoute does not override when weighted intent score is not higher than baseline", () => {
    const weights = {
      version: 1 as const,
      signals: { "debug:debug": 1, "other:other": 1 },
      feedback: [],
    };
    const result = applyWeightsToRoute(
      baseRoute("other"),
      "please debug this failure",
      weights
    );
    expect(result.intent).toBe("other");
    expect(result.warnings).toEqual([]);
  });

  it("scoreIntentsDiscriminative damps tokens spread across many intents", () => {
    // "x" is typed a lot but appears under 3 intents (low information);
    // "y" appears under only 1 intent (high information). Raw counts would
    // crown intent A (x:A = 10), but the discriminative scorer lets the
    // genuinely distinguishing token "y" carry intent B to the top.
    const signals = {
      "x:A": 10,
      "x:B": 3,
      "x:C": 3,
      "y:B": 4,
    };

    const raw = scoreIntentsFromPrompt("x y", signals);
    expect(raw.A).toBeGreaterThan(raw.B!); // raw counting prefers A

    const scores = scoreIntentsDiscriminative("x y", signals);
    expect(scores.B).toBeGreaterThan(scores.A!); // IDF flips the winner to B
  });

  it("applyWeightsToRoute uses discriminative scoring to pick the better intent", () => {
    const weights = {
      version: 1 as const,
      signals: { "x:A": 10, "x:B": 3, "x:C": 3, "y:B": 4 },
      feedback: [],
    };
    const result = applyWeightsToRoute(baseRoute("C"), "x y", weights);
    expect(result.intent).toBe("B");
  });

  it("applyWeightsToRoute keeps plugin intent when it wins", () => {
    const weights = {
      version: 1 as const,
      signals: { "debug:debug": 1, "security:security": 10 },
      feedback: [],
    };
    const result = applyWeightsToRoute(
      baseRoute("security"),
      "security audit required",
      weights
    );
    expect(result.intent).toBe("security");
    expect(result.warnings).toEqual([]);
  });
});
