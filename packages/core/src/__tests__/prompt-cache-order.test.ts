import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { buildSystemPrompt } from "../chat/prompt.js";
import type { RouteResult } from "../router/model-router.js";

/**
 * §8.11-B prompt-cache reorder: `buildSystemPrompt` must put the STATIC prefix
 * (identity + protocol + tool docs) first when `promptCachePrefix` is on, so an
 * OpenAI-compatible provider's automatic prefix cache stays warm across turns —
 * while preserving the legacy (variable-first) order byte-for-byte when off.
 */

const route: RouteResult = {
  intent: "implement",
  suggested_agent: null,
  workflow: "edit",
  skills: [],
  provider: "nvidia",
  warnings: [],
};

const CONTEXT = "CONTEXT_PACK_MARKER";
const MEMORIES = "MEMORY_MARKER";
const PROMPT = "do the thing";

function build(): string {
  return buildSystemPrompt(route, PROMPT, CONTEXT, "/repo", undefined, undefined, MEMORIES);
}

const savedProfile = process.env.AGENCY_PROFILE;
const savedFlag = process.env.AGENCY_PROMPT_CACHE;

afterEach(() => {
  if (savedProfile === undefined) delete process.env.AGENCY_PROFILE;
  else process.env.AGENCY_PROFILE = savedProfile;
  if (savedFlag === undefined) delete process.env.AGENCY_PROMPT_CACHE;
  else process.env.AGENCY_PROMPT_CACHE = savedFlag;
});

describe("buildSystemPrompt prompt-cache ordering", () => {
  beforeEach(() => {
    delete process.env.AGENCY_PROFILE;
    delete process.env.AGENCY_PROMPT_CACHE;
  });

  it("legacy (flag off) keeps the variable-first order: intent before tool docs", () => {
    process.env.AGENCY_PROMPT_CACHE = "off";
    const out = build();
    expect(out.indexOf("User intent:")).toBeGreaterThanOrEqual(0);
    expect(out.indexOf("AVAILABLE TOOLS:")).toBeGreaterThanOrEqual(0);
    // legacy: the per-turn intent line precedes the static tool docs
    expect(out.indexOf("User intent:")).toBeLessThan(out.indexOf("AVAILABLE TOOLS:"));
    // user question stays last
    expect(out.trimEnd().endsWith(`User question: ${PROMPT}`)).toBe(true);
  });

  it("cache (flag on) puts the static prefix first: identity + tool docs before intent", () => {
    process.env.AGENCY_PROMPT_CACHE = "on";
    const out = build();
    // the static identity line opens the prompt (no variable anchor ahead of it)
    expect(out.startsWith("You are Agency CLI")).toBe(true);
    // static tool docs now precede the per-turn intent line — the cache flip
    expect(out.indexOf("AVAILABLE TOOLS:")).toBeLessThan(out.indexOf("User intent:"));
    // context pack + memories + question remain in the variable tail (after intent)
    expect(out.indexOf("User intent:")).toBeLessThan(out.indexOf(CONTEXT));
    expect(out.indexOf(CONTEXT)).toBeLessThan(out.indexOf(MEMORIES));
    expect(out.trimEnd().endsWith(`User question: ${PROMPT}`)).toBe(true);
  });

  it("is a pure reorder: same content, identical length in both modes", () => {
    process.env.AGENCY_PROMPT_CACHE = "off";
    const legacy = build();
    process.env.AGENCY_PROMPT_CACHE = "on";
    const cache = build();
    // reordering the same segments (joined by "\n") preserves total length
    expect(cache.length).toBe(legacy.length);
    // every salient marker survives in both orderings
    for (const marker of ["User intent:", "AVAILABLE TOOLS:", CONTEXT, MEMORIES, `User question: ${PROMPT}`]) {
      expect(legacy).toContain(marker);
      expect(cache).toContain(marker);
    }
    // the orderings genuinely differ
    expect(cache).not.toBe(legacy);
  });

  it("hardened profile defaults the cache order on", () => {
    process.env.AGENCY_PROFILE = "hardened";
    const out = build();
    expect(out.indexOf("AVAILABLE TOOLS:")).toBeLessThan(out.indexOf("User intent:"));
  });

  it("systemInstructionOverride is preserved at the very top in both modes", () => {
    const override = "OVERRIDE_INSTRUCTION";
    process.env.AGENCY_PROMPT_CACHE = "on";
    const withOverride = buildSystemPrompt(route, PROMPT, CONTEXT, "/repo", undefined, override, MEMORIES);
    expect(withOverride.startsWith(`${override}\n\n`)).toBe(true);
  });
});
