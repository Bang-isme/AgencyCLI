import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RouteResult } from "../router/model-router.js";
import { buildContextPack } from "../context/pack.js";
import { selectContextFiles } from "../context/selector.js";
import {
  getCachedRoute,
  setCachedRoute,
} from "../context/session-cache.js";
import {
  getTokenBudgetPlan,
  parseBudgetMode,
  type BudgetMode,
} from "../context/token-policy.js";
import { buildIndex, writeIndex } from "../index/workspace-indexer.js";

const SAMPLE_ROUTE: RouteResult = {
  intent: "debug",
  suggested_agent: null,
  workflow: "fix",
  skills: ["codex-systematic-debugging"],
  provider: "anthropic",
  warnings: [],
};

function makeProjectWithIndex(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "agency-token-policy-"));
  for (const [relPath, content] of Object.entries(files)) {
    const fullPath = join(root, relPath);
    mkdirSync(join(fullPath, ".."), { recursive: true });
    writeFileSync(fullPath, content, "utf8");
  }
  writeIndex(root, buildIndex(root));
  return root;
}

describe("token-policy", () => {
  it("getTokenBudgetPlan returns mode-specific limits", () => {
    const modes: BudgetMode[] = ["tight", "normal", "deep"];
    for (const mode of modes) {
      const plan = getTokenBudgetPlan(mode);
      expect(plan.mode).toBe(mode);
      expect(plan.maxContextFiles).toBeGreaterThanOrEqual(0);
      expect(plan.maxContextChars).toBeGreaterThan(0);
      expect(plan.maxLlmOutputTokens).toBeGreaterThan(0);
    }

    expect(getTokenBudgetPlan("tight").maxContextFiles).toBe(0);
    expect(getTokenBudgetPlan("normal").maxContextFiles).toBe(12);
    expect(getTokenBudgetPlan("deep").maxContextFiles).toBe(25);
    expect(getTokenBudgetPlan("deep").allowPreflight).toBe(true);
    expect(getTokenBudgetPlan("tight").allowPreflight).toBe(false);
  });

  it("getTokenBudgetPlan defaults to normal", () => {
    expect(getTokenBudgetPlan().mode).toBe("normal");
  });

  it("parseBudgetMode accepts valid modes and falls back to normal", () => {
    expect(parseBudgetMode("tight")).toBe("tight");
    expect(parseBudgetMode("normal")).toBe("normal");
    expect(parseBudgetMode("deep")).toBe("deep");
    expect(parseBudgetMode("invalid")).toBe("normal");
    expect(parseBudgetMode(undefined)).toBe("normal");
  });
});

describe("selectContextFiles", () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = makeProjectWithIndex({
      "src/auth/login.ts": "export function login() {}",
      "src/utils/helpers.ts": "export const helper = 1;",
      "README.md": "# project",
    });
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it("returns empty when maxContextFiles is zero", () => {
    const plan = getTokenBudgetPlan("tight");
    expect(selectContextFiles(projectRoot, SAMPLE_ROUTE, plan)).toEqual([]);
  });

  it("scores files by route skill keywords", () => {
    const root = makeProjectWithIndex({
      "src/debug/trace.ts": "export const trace = true;",
      "src/utils/helpers.ts": "export const helper = 1;",
    });
    try {
      const plan = getTokenBudgetPlan("normal");
      const selected = selectContextFiles(root, SAMPLE_ROUTE, plan);
      expect(selected).toContain("src/debug/trace.ts");
      expect(selected).not.toContain("src/utils/helpers.ts");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("prefers paths matching route intent tokens", () => {
    const authRoute: RouteResult = {
      ...SAMPLE_ROUTE,
      intent: "auth",
      skills: [],
    };
    const plan = getTokenBudgetPlan("normal");
    const selected = selectContextFiles(projectRoot, authRoute, plan);
    expect(selected[0]).toBe("src/auth/login.ts");
  });

  it("returns empty when index is missing", () => {
    const missingRoot = mkdtempSync(join(tmpdir(), "agency-no-index-"));
    try {
      const plan = getTokenBudgetPlan("normal");
      expect(selectContextFiles(missingRoot, SAMPLE_ROUTE, plan)).toEqual([]);
    } finally {
      rmSync(missingRoot, { recursive: true, force: true });
    }
  });
});

describe("session-cache", () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), "agency-route-cache-"));
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
    vi.useRealTimers();
  });

  it("stores and retrieves route by prompt", () => {
    setCachedRoute(projectRoot, "fix auth bug", SAMPLE_ROUTE);
    expect(getCachedRoute(projectRoot, "fix auth bug")).toEqual(SAMPLE_ROUTE);
    expect(getCachedRoute(projectRoot, "other prompt")).toBeNull();
  });

  it("writes cache file under .agency/session/route-cache.json", () => {
    setCachedRoute(projectRoot, "hello", SAMPLE_ROUTE);
    const cachePath = join(
      projectRoot,
      ".agency",
      "session",
      "route-cache.json"
    );
    expect(existsSync(cachePath)).toBe(true);
    const raw = JSON.parse(readFileSync(cachePath, "utf8")) as {
      version: number;
      entries: Record<string, unknown>;
    };
    expect(raw.version).toBe(1);
    expect(Object.keys(raw.entries)).toHaveLength(1);
  });

  it("expires entries after one hour", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-20T10:00:00.000Z"));
    setCachedRoute(projectRoot, "fix auth bug", SAMPLE_ROUTE);

    vi.setSystemTime(new Date("2026-05-20T10:59:59.000Z"));
    expect(getCachedRoute(projectRoot, "fix auth bug")).toEqual(SAMPLE_ROUTE);

    vi.setSystemTime(new Date("2026-05-20T11:00:01.000Z"));
    expect(getCachedRoute(projectRoot, "fix auth bug")).toBeNull();
  });
});

describe("buildContextPack", () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = makeProjectWithIndex({
      "src/auth/login.ts": "export function login() { return true; }",
      "README.md": "# Auth service",
    });
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it("returns compact markdown with route summary", () => {
    const plan = getTokenBudgetPlan("normal");
    const authRoute: RouteResult = { ...SAMPLE_ROUTE, intent: "auth" };
    const pack = buildContextPack(projectRoot, authRoute, plan);

    expect(pack.startsWith("# Context")).toBe(true);
    expect(pack).toContain("intent: auth");
    expect(pack).toContain("src/auth/login.ts");
    expect(pack.length).toBeLessThanOrEqual(plan.maxContextChars);
  });

  it("respects tight budget with route-only output", () => {
    const plan = getTokenBudgetPlan("tight");
    const pack = buildContextPack(projectRoot, SAMPLE_ROUTE, plan);

    expect(pack).toContain("intent: debug");
    expect(pack).not.toContain("## Files");
    expect(pack.length).toBeLessThanOrEqual(plan.maxContextChars);
  });
});
