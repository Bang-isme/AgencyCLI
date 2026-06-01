import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { buildSystemPrompt } from "../chat/prompt.js";
import type { RouteResult } from "../router/model-router.js";

/**
 * §8.11-D — `compactToolDocs` collapses each built-in tool's args to one terse
 * `Args: ...` line (dropping the per-arg "Parameter of type string." boilerplate
 * that is re-sent every turn) while preserving the schema the model needs (arg
 * names + optional marker + non-string types). Off = verbose, byte-identical.
 */

const route: RouteResult = {
  intent: "implement",
  suggested_agent: null,
  workflow: "edit",
  skills: [],
  provider: "nvidia",
  warnings: [],
};

function build(): string {
  return buildSystemPrompt(route, "do the thing", "CTX", "/repo", undefined, undefined, "MEM");
}

const saved = {
  profile: process.env.AGENCY_PROFILE,
  compact: process.env.AGENCY_COMPACT_TOOL_DOCS,
  cache: process.env.AGENCY_PROMPT_CACHE,
};

beforeEach(() => {
  delete process.env.AGENCY_PROFILE;
  delete process.env.AGENCY_COMPACT_TOOL_DOCS;
  delete process.env.AGENCY_PROMPT_CACHE;
});

afterEach(() => {
  for (const [k, v] of [["AGENCY_PROFILE", saved.profile], ["AGENCY_COMPACT_TOOL_DOCS", saved.compact], ["AGENCY_PROMPT_CACHE", saved.cache]] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("§8.11-D compact tool docs", () => {
  it("legacy (flag off) keeps the verbose per-arg form byte-for-byte", () => {
    process.env.AGENCY_COMPACT_TOOL_DOCS = "off";
    const out = build();
    expect(out).toContain("   Arguments:");
    expect(out).toContain("Parameter of type string.");
    // The write_file args are listed verbosely.
    expect(out).toContain("- `<path>`: Parameter of type string.");
    expect(out).toContain("- `<content>`: Parameter of type string.");
    expect(out).not.toContain("   Args: ");
  });

  it("compact (flag on) replaces per-arg lines with one terse Args line", () => {
    process.env.AGENCY_COMPACT_TOOL_DOCS = "on";
    const out = build();
    expect(out).toContain("   Args: ");
    // Boilerplate is gone for built-in tools.
    expect(out).not.toContain("Parameter of type string.");
    // The schema the model needs survives: arg names still present.
    expect(out).toContain("`path`");
    expect(out).toContain("`content`");
  });

  it("compact is strictly shorter (saves prompt tokens)", () => {
    process.env.AGENCY_COMPACT_TOOL_DOCS = "off";
    const verbose = build();
    process.env.AGENCY_COMPACT_TOOL_DOCS = "on";
    const compact = build();
    expect(compact.length).toBeLessThan(verbose.length);
    // Both still list the same tool names + the section header.
    expect(compact).toContain("AVAILABLE TOOLS:");
    expect(compact).toContain("`write_file`");
    expect(verbose).toContain("`write_file`");
  });

  it("hardened profile defaults compact on", () => {
    process.env.AGENCY_PROFILE = "hardened";
    const out = build();
    expect(out).toContain("   Args: ");
    expect(out).not.toContain("Parameter of type string.");
  });

  it("marks optional args with `?` and shows non-string types in compact mode", () => {
    process.env.AGENCY_COMPACT_TOOL_DOCS = "on";
    const out = build();
    // grep_search has optional args incl. booleans (case_sensitive / is_regex)
    // and a numeric limit → the compact form annotates `?` and the non-string type.
    expect(out).toMatch(/`[a-z_]+\?`/); // at least one optional arg marked
    expect(out).toMatch(/: (boolean|string \| number)/); // at least one typed arg
  });
});
