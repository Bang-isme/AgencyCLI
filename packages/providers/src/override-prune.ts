import { getCatalogSpec } from "./model-catalog.js";
import type { AgencyConfig } from "./types.js";

function baselineContextWindow(model: string): number {
  return getCatalogSpec(model)?.contextWindow ?? 128_000;
}

/**
 * Drop stale `contextWindow` overrides written by the old context-retry ratchet
 * (×0.8 persisted to ~/.agency/config.json). Keeps intentional user overrides
 * that match or exceed ~95% of the catalog baseline.
 */
export function pruneStaleContextWindowOverrides(cfg: AgencyConfig): AgencyConfig {
  if (!cfg.modelOverrides || Object.keys(cfg.modelOverrides).length === 0) return cfg;

  const nextOverrides = { ...cfg.modelOverrides };
  let changed = false;

  for (const [model, override] of Object.entries(cfg.modelOverrides)) {
    if (typeof override.contextWindow !== "number") continue;
    const baseline = baselineContextWindow(model);
    if (override.contextWindow >= baseline * 0.95) continue;

    const { contextWindow: _dropped, ...rest } = override;
    changed = true;
    if (Object.keys(rest).length === 0) {
      delete nextOverrides[model];
    } else {
      nextOverrides[model] = rest;
    }
  }

  if (!changed) return cfg;
  return { ...cfg, modelOverrides: nextOverrides };
}
