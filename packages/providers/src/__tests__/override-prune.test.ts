import { describe, expect, it } from "vitest";
import { pruneStaleContextWindowOverrides } from "../override-prune.js";
import type { AgencyConfig } from "../types.js";

describe("pruneStaleContextWindowOverrides", () => {
  it("removes retry-ratchet contextWindow overrides below catalog baseline", () => {
    const cfg: AgencyConfig = {
      defaultProvider: "nvidia",
      providers: {},
      modelOverrides: {
        "MiniMax-M3": {
          contextWindow: 800_000,
          maxOutputTokens: 8192,
          thinkingType: "effort",
        },
      },
    };
    const pruned = pruneStaleContextWindowOverrides(cfg);
    expect(pruned.modelOverrides?.["MiniMax-M3"]?.contextWindow).toBeUndefined();
    expect(pruned.modelOverrides?.["MiniMax-M3"]?.maxOutputTokens).toBe(8192);
  });

  it("keeps overrides that match catalog within 95%", () => {
    const cfg: AgencyConfig = {
      defaultProvider: "nvidia",
      providers: {},
      modelOverrides: {
        "MiniMax-M3": { contextWindow: 1_000_000 },
      },
    };
    expect(pruneStaleContextWindowOverrides(cfg)).toBe(cfg);
  });
});
