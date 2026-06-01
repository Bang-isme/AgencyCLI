import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Model catalog — reads the repository's `models.json` (the models.dev-style
 * catalog of ~5k models across ~135 providers) and exposes accurate per-model
 * limits / cost / capabilities. This is the BYOK win: for *any* model the user
 * brings, we get the real context window, max output, $/Mtok and capabilities
 * instead of a hand-curated registry + heuristic guessing.
 *
 * Design notes (no duplication):
 *  - The model-key matcher {@link matchModelKey} is shared with the in-code
 *    registry in `thinking-spec.ts` (that file delegates to it), so there is one
 *    matching algorithm, not two.
 *  - The catalog ENRICHES the existing spec chain — it never replaces the
 *    registry/override/heuristics. `getModelSpec` merges it in.
 *  - Loading is lazy + cached + best-effort: a missing/broken `models.json`
 *    leaves the catalog empty and the runtime falls back to today's behaviour.
 *  - The catalog data lives in THIS package (`packages/providers/models.json`,
 *    shipped via the package `files`) so it resolves both in dev and from an
 *    installed `node_modules/@agency/providers`. It is located at runtime:
 *    env override (`AGENCY_MODELS_JSON`) → walk up from this module → cwd.
 */

export interface CatalogCapabilities {
  toolCall?: boolean;
  temperature?: boolean;
  reasoning?: boolean;
  vision?: boolean;
}

export interface CatalogSpec {
  contextWindow?: number;
  maxOutputTokens?: number;
  /** USD per 1,000,000 tokens. */
  cost?: { input: number; output: number };
  capabilities?: CatalogCapabilities;
}

// --- enable toggle ---------------------------------------------------------
// providers is a dependency of core, so it can't read core's runtime flags
// (that would be a cycle). The host (core bootstrap) flips this from
// flags.modelCatalog. Off by default → catalog is never consulted (legacy).
let catalogEnabled = false;
export function setModelCatalogEnabled(on: boolean): void {
  catalogEnabled = on;
}
export function isModelCatalogEnabled(): boolean {
  return catalogEnabled;
}

/**
 * Shared model-id matcher: exact → strip provider prefix → longest-prefix →
 * substring (same strategy the in-code registry uses). Keys are assumed
 * lowercased; `model` is lowercased here. Returns the matched key or null.
 */
export function matchModelKey(model: string, keys: readonly string[]): string | null {
  if (!model || typeof model !== "string") return null;
  const id = model.toLowerCase();
  const base = id.split("/").pop() ?? id;

  if (keys.includes(id)) return id;
  if (base !== id && keys.includes(base)) return base;

  let bestPrefix = "";
  for (const key of keys) {
    if (base.startsWith(key) && key.length > bestPrefix.length) bestPrefix = key;
  }
  if (bestPrefix) return bestPrefix;

  for (const key of keys) {
    if (id.includes(key)) return key;
  }
  return null;
}

// --- catalog index ---------------------------------------------------------

interface RawModelEntry {
  limit?: { context?: number; output?: number };
  cost?: { input?: number; output?: number };
  tool_call?: boolean;
  temperature?: boolean;
  reasoning?: boolean;
  attachment?: boolean;
  modalities?: { input?: string[]; output?: string[] };
}

// Direct providers preferred when the same bare model id exists under several
// providers (e.g. "claude-opus-4-5" appears under anthropic and 5 aggregators).
// Processing these first makes the bare-id lookup resolve to canonical pricing.
const CANONICAL_PROVIDERS = [
  "anthropic", "openai", "google", "xai", "mistral",
  "deepseek", "groq", "cohere", "meta", "google-vertex",
];

let catalogIndex: Map<string, CatalogSpec> | null = null;
let catalogKeys: readonly string[] = [];
let loadAttempted = false;
const lookupCache = new Map<string, CatalogSpec | null>();

// Every context window any provider lists for a given BARE model id (the last
// path segment, e.g. "minimax-m2.7"), used for the conservative provider-aware
// bound — see getCatalogSpec.
let bareIdContexts = new Map<string, number[]>();

// When several providers list the same bare model id with different context
// windows, ignore entries below this fraction of the group's max as router-cap
// outliers (e.g. a meta-router that caps everything at 100k), then take the
// smallest of the rest. Keeps the conservative bound from collapsing to an
// absurd low while still protecting against a single wrong-high provider entry.
const CONSERVATIVE_OUTLIER_RATIO = 0.5;

function findModelsJsonPath(): string | null {
  const candidates: string[] = [];
  const envPath = process.env.AGENCY_MODELS_JSON;
  if (envPath) candidates.push(envPath);
  try {
    let dir = dirname(fileURLToPath(import.meta.url));
    for (let i = 0; i < 8; i++) {
      candidates.push(join(dir, "models.json"));
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
    /* ignore — fall through to cwd */
  }
  candidates.push(join(process.cwd(), "models.json"));

  for (const c of candidates) {
    try {
      if (existsSync(c)) return c;
    } catch {
      /* keep trying */
    }
  }
  return null;
}

function entryToCatalogSpec(e: RawModelEntry): CatalogSpec {
  const inputs = e.modalities?.input ?? [];
  const vision = e.attachment === true || inputs.includes("image") || inputs.includes("pdf");
  const spec: CatalogSpec = {
    capabilities: {
      toolCall: e.tool_call,
      temperature: e.temperature,
      reasoning: e.reasoning,
      vision,
    },
  };
  if (typeof e.limit?.context === "number") spec.contextWindow = e.limit.context;
  if (typeof e.limit?.output === "number") spec.maxOutputTokens = e.limit.output;
  if (typeof e.cost?.input === "number" && typeof e.cost?.output === "number") {
    spec.cost = { input: e.cost.input, output: e.cost.output };
  }
  return spec;
}

function ensureLoaded(): void {
  if (loadAttempted) return;
  loadAttempted = true;
  const index = new Map<string, CatalogSpec>();
  const groups = new Map<string, number[]>();
  try {
    const path = findModelsJsonPath();
    if (path) {
      const raw = JSON.parse(readFileSync(path, "utf8")) as Record<
        string,
        { models?: Record<string, RawModelEntry> }
      >;
      const providerIds = Object.keys(raw);
      const ordered = [
        ...CANONICAL_PROVIDERS.filter((p) => raw[p]),
        ...providerIds.filter((p) => !CANONICAL_PROVIDERS.includes(p)),
      ];
      for (const providerId of ordered) {
        const models = raw[providerId]?.models;
        if (!models || typeof models !== "object") continue;
        for (const [modelId, entry] of Object.entries(models)) {
          if (!entry || typeof entry !== "object") continue;
          const spec = entryToCatalogSpec(entry);
          const idKey = modelId.toLowerCase();
          const fqKey = `${providerId}/${modelId}`.toLowerCase();
          if (!index.has(idKey)) index.set(idKey, spec); // first (canonical) wins
          index.set(fqKey, spec);
          // Record this entry's context under its BARE model id so the
          // conservative provider-aware bound can see every provider's value.
          if (typeof spec.contextWindow === "number") {
            const bare = idKey.split("/").pop() ?? idKey;
            const arr = groups.get(bare);
            if (arr) arr.push(spec.contextWindow);
            else groups.set(bare, [spec.contextWindow]);
          }
        }
      }
    }
  } catch {
    /* best-effort: empty catalog → runtime falls back to legacy specs */
  }
  catalogIndex = index;
  catalogKeys = Array.from(index.keys());
  bareIdContexts = groups;
}

/**
 * The conservative context window for a bare model id: the smallest context any
 * provider lists for it, after dropping router-cap outliers below half the
 * group max. Returns null when the model isn't in the catalog. This is what lets
 * a budget stay below the *real* limit of the user's provider even when that
 * provider's own catalog entry is wrong-high (the minimax-m2.7-on-NVIDIA bug:
 * the file lists nvidia at 204800 but the API enforces 196608, which other
 * providers report correctly).
 */
function conservativeContextForBareId(bare: string): number | null {
  const ctxs = bareIdContexts.get(bare);
  if (!ctxs || ctxs.length === 0) return null;
  let max = 0;
  for (const c of ctxs) if (c > max) max = c;
  const floor = max * CONSERVATIVE_OUTLIER_RATIO;
  let min = Infinity;
  for (const c of ctxs) if (c >= floor && c < min) min = c;
  return Number.isFinite(min) ? min : max;
}

/**
 * Provider-agnostic resolution (the legacy lookup): exact key → shared matcher
 * (exact/strip-prefix/longest-prefix/substring) → catalog-only reverse-prefix
 * pass so a short canonical id matches a dated catalog id on a token boundary.
 */
function resolveAgnostic(model: string): CatalogSpec | null {
  if (!catalogIndex) return null;
  let key = matchModelKey(model, catalogKeys);
  if (!key) {
    const base = model.toLowerCase().split("/").pop() ?? model.toLowerCase();
    let best = "";
    for (const k of catalogKeys) {
      if ((k === base || k.startsWith(`${base}-`)) && (best === "" || k.length < best.length)) {
        best = k;
      }
    }
    key = best || null;
  }
  return key ? catalogIndex.get(key) ?? null : null;
}

/**
 * Resolves a model string to its catalog spec, or null when not found / catalog
 * unavailable.
 *
 * When `providerId` is supplied the lookup becomes PROVIDER-AWARE:
 *  1. The user's own `<provider>/<model>` entry (if present) supplies the spec
 *     body — its cost, capabilities and max-output are the most accurate.
 *  2. The context window is then CLAMPED DOWN to the conservative robust-min
 *     across every provider that lists the same bare model id. A single
 *     provider's catalog entry can be wrong-high — e.g. `nvidia/minimax-m2.7`
 *     lists 204800 but the NVIDIA API enforces 196608, the value other
 *     providers report — and over-allocating the budget is exactly what
 *     overflows the window and crashes the turn. Clamping never over-allows.
 *
 * Without `providerId` it is the legacy provider-agnostic resolution, byte for
 * byte, so callers that don't opt in are unaffected.
 */
export function getCatalogSpec(model: string, providerId?: string): CatalogSpec | null {
  if (!model || typeof model !== "string") return null;
  const cacheId = providerId ? `${providerId.toLowerCase()}::${model}` : model;
  if (lookupCache.has(cacheId)) return lookupCache.get(cacheId) ?? null;

  ensureLoaded();
  if (!catalogIndex || catalogKeys.length === 0) {
    lookupCache.set(cacheId, null);
    return null;
  }

  let base = resolveAgnostic(model);

  if (providerId) {
    const lower = model.toLowerCase();
    const bare = lower.split("/").pop() ?? lower;
    const pid = providerId.toLowerCase();
    // Prefer the user's exact provider entry for the spec body.
    const exact = catalogIndex.get(`${pid}/${lower}`) ?? catalogIndex.get(`${pid}/${bare}`);
    if (exact) base = exact;
    // Clamp the context down to the conservative cross-provider minimum.
    if (base) {
      const conservative = conservativeContextForBareId(bare);
      if (
        conservative !== null &&
        (base.contextWindow === undefined || conservative < base.contextWindow)
      ) {
        base = { ...base, contextWindow: conservative };
      }
    }
  }

  lookupCache.set(cacheId, base);
  return base;
}

/** Test-only: clear cached catalog so the next lookup reloads. */
export function __resetModelCatalog(): void {
  catalogIndex = null;
  catalogKeys = [];
  loadAttempted = false;
  lookupCache.clear();
  bareIdContexts = new Map();
}
