import { describe, expect, it, afterEach } from "vitest";
import {
  getCatalogSpec,
  matchModelKey,
  setModelCatalogEnabled,
  __resetModelCatalog,
} from "../model-catalog.js";
import { getModelSpec } from "../thinking-spec.js";

afterEach(() => {
  setModelCatalogEnabled(false);
  __resetModelCatalog();
});

describe("matchModelKey (shared matcher)", () => {
  const keys = ["anthropic/claude-3-5-sonnet", "claude-3-5-sonnet", "gpt-4o", "gemini-2.5-pro"];

  it("matches exactly", () => {
    expect(matchModelKey("gpt-4o", keys)).toBe("gpt-4o");
  });
  it("strips the provider prefix", () => {
    expect(matchModelKey("openai/gpt-4o", keys)).toBe("gpt-4o");
  });
  it("longest-prefix matches a dated suffix", () => {
    expect(matchModelKey("claude-3-5-sonnet-20241022", keys)).toBe("claude-3-5-sonnet");
  });
  it("returns null when nothing matches", () => {
    expect(matchModelKey("totally-unknown-xyz", keys)).toBeNull();
  });
});

describe("getCatalogSpec (loads the real models.json)", () => {
  it("resolves accurate limits + cost + capabilities for a canonical model", () => {
    const spec = getCatalogSpec("anthropic/claude-opus-4-5");
    expect(spec).not.toBeNull();
    expect(spec!.contextWindow).toBe(200000);
    expect(typeof spec!.maxOutputTokens).toBe("number");
    expect(spec!.cost).toBeDefined();
    expect(spec!.cost!.input).toBeGreaterThan(0);
    expect(spec!.cost!.output).toBeGreaterThan(0);
    expect(spec!.capabilities?.toolCall).toBe(true);
    expect(spec!.capabilities?.vision).toBe(true);
  });

  it("resolves a bare canonical id (prefers a canonical provider's entry)", () => {
    const spec = getCatalogSpec("gpt-4o");
    expect(spec).not.toBeNull();
    expect(typeof spec!.contextWindow).toBe("number");
    expect(spec!.cost).toBeDefined();
  });

  it("returns null for an unknown model", () => {
    expect(getCatalogSpec("nonexistent-model-zzz-999")).toBeNull();
  });
});

describe("getModelSpec catalog enrichment (flag-gated)", () => {
  it("does NOT enrich when the catalog is disabled (legacy behaviour)", () => {
    setModelCatalogEnabled(false);
    const spec = getModelSpec("anthropic/claude-opus-4-5");
    expect(spec.cost).toBeUndefined();
    expect(spec.capabilities).toBeUndefined();
  });

  it("adds cost + capabilities when enabled, keeping the registry's limits", () => {
    setModelCatalogEnabled(true);
    const spec = getModelSpec("anthropic/claude-opus-4-5");
    expect(spec.cost).toBeDefined();
    expect(spec.cost!.input).toBeGreaterThan(0);
    expect(spec.capabilities?.toolCall).toBe(true);
    // claude context window is authoritative (200k) regardless of source.
    expect(spec.contextWindow).toBe(200000);
  });
});
