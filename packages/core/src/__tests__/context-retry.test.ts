import { describe, expect, it, beforeEach } from "vitest";
import {
  clearSessionContextLimits,
  getCatalogContextWindow,
  resolveContextRetryLimit,
  setSessionContextLimit,
} from "../chat/context-retry.js";

describe("context-retry", () => {
  beforeEach(() => {
    clearSessionContextLimits();
  });

  it("returns catalog limit when no provider parse and no session override", () => {
    const catalog = getCatalogContextWindow("gpt-4o-mini", "openrouter");
    const trim = resolveContextRetryLimit("sess-1", "gpt-4o-mini", "openrouter", null);
    expect(trim).toBe(catalog);
  });

  it("uses provider-parsed limit when below catalog", () => {
    const catalog = getCatalogContextWindow("gpt-4o-mini", "openrouter");
    const trim = resolveContextRetryLimit("sess-2", "gpt-4o-mini", "openrouter", 128_000);
    expect(trim).toBe(Math.min(128_000, catalog));
  });

  it("reuses session-scoped limit on subsequent retries", () => {
    setSessionContextLimit("sess-3", "gpt-4o-mini", "openrouter", 100_000);
    expect(resolveContextRetryLimit("sess-3", "gpt-4o-mini", "openrouter", null)).toBe(100_000);
  });
});
