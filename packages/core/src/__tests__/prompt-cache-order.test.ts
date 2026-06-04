import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { buildSystemPrompt } from "../chat/prompt.js";
import { getAgentRegistrySnapshot } from "../agents/agent-registry.js";
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
const savedApproaches = process.env.AGENCY_SOFT_APPROACHES;

afterEach(() => {
  if (savedProfile === undefined) delete process.env.AGENCY_PROFILE;
  else process.env.AGENCY_PROFILE = savedProfile;
  if (savedFlag === undefined) delete process.env.AGENCY_PROMPT_CACHE;
  else process.env.AGENCY_PROMPT_CACHE = savedFlag;
  if (savedApproaches === undefined) delete process.env.AGENCY_SOFT_APPROACHES;
  else process.env.AGENCY_SOFT_APPROACHES = savedApproaches;
});

describe("buildSystemPrompt prompt-cache ordering", () => {
  beforeEach(() => {
    delete process.env.AGENCY_PROFILE;
    delete process.env.AGENCY_PROMPT_CACHE;
    delete process.env.AGENCY_SOFT_APPROACHES;
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

describe("buildSystemPrompt specialist roster (dispatch_subagent coupling)", () => {
  beforeEach(() => {
    delete process.env.AGENCY_PROFILE;
    delete process.env.AGENCY_PROMPT_CACHE;
  });

  it("advertises every dispatchable specialist agentId from the registry", () => {
    const out = build();
    expect(out).toContain("AVAILABLE SPECIALISTS");
    const agents = getAgentRegistrySnapshot();
    expect(agents.length).toBeGreaterThan(0);
    for (const a of agents) {
      // the exact agentId the model must pass to dispatch_subagent
      expect(out).toContain(`\`${a.id}\``);
    }
  });

  it("places the roster with the static tool docs (before the variable tail in cache mode)", () => {
    process.env.AGENCY_PROMPT_CACHE = "on";
    const out = build();
    expect(out.indexOf("AVAILABLE SPECIALISTS")).toBeLessThan(out.indexOf("User intent:"));
  });
});

describe("buildSystemPrompt soft-approaches rule (§8.11-C)", () => {
  beforeEach(() => {
    delete process.env.AGENCY_PROFILE;
    delete process.env.AGENCY_PROMPT_CACHE;
    delete process.env.AGENCY_SOFT_APPROACHES;
  });

  it("opt-out (AGENCY_SOFT_APPROACHES=0) restores the rigid exactly-5 rule verbatim", () => {
    process.env.AGENCY_SOFT_APPROACHES = "off";
    const out = build();
    expect(out).toContain("THE 5-APPROACHES RULE");
    expect(out).toContain("exactly 5 distinct");
    expect(out).not.toContain("SOLUTION OPTIONS");
  });

  it("softened (flag on) drops the exactly-5 mandate for a complexity-scaled rule", () => {
    process.env.AGENCY_SOFT_APPROACHES = "on";
    const out = build();
    expect(out).not.toContain("exactly 5 distinct");
    expect(out).not.toContain("THE 5-APPROACHES RULE");
    expect(out).toContain("SOLUTION OPTIONS");
    expect(out).toContain("single clear recommendation");
    // the prioritization-gradient step survives in both modes
    expect(out).toContain("PRIORITIZATION GRADIENT");
  });

  it("hardened profile defaults the softened rule on", () => {
    process.env.AGENCY_PROFILE = "hardened";
    const out = build();
    expect(out).not.toContain("exactly 5 distinct");
    expect(out).toContain("SOLUTION OPTIONS");
  });

  it("is independent of the cache-order flag", () => {
    // soft-approaches on while cache order stays off (legacy ordering)
    process.env.AGENCY_SOFT_APPROACHES = "on";
    process.env.AGENCY_PROMPT_CACHE = "off";
    const out = build();
    expect(out).toContain("SOLUTION OPTIONS");
    // legacy order intact: intent before tool docs
    expect(out.indexOf("User intent:")).toBeLessThan(out.indexOf("AVAILABLE TOOLS:"));
  });
});
