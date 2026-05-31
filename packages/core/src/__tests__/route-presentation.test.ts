import { describe, expect, it } from "vitest";
import { formatRouteForSurface } from "../chat/presentation.js";
import type { RouteResult } from "../router/model-router.js";

const route: RouteResult = {
  intent: "debug",
  suggested_agent: "debugger",
  workflow: "fix",
  skills: ["codex-systematic-debugging"],
  provider: "openrouter",
  warnings: [],
};

describe("formatRouteForSurface", () => {
  it("human surface shows chips and next steps without JSON", () => {
    const { stdout } = formatRouteForSurface(route, "fix test", "/proj", "human");
    expect(stdout).toContain("intent debug");
    expect(stdout).toContain("workflow fix");
    expect(stdout).not.toContain("Next");
    expect(stdout).not.toContain("{");
  });

  it("json surface returns route object", () => {
    const { stdout } = formatRouteForSurface(route, "x", "/proj", "json");
    const parsed = JSON.parse(stdout) as { route: RouteResult };
    expect(parsed.route.intent).toBe("debug");
  });
});
