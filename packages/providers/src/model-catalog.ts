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
        }
      }
    }
  } catch {
    /* best-effort: empty catalog → runtime falls back to legacy specs */
  }
  catalogIndex = index;
  catalogKeys = Array.from(index.keys());
}

/**
 * Resolves a model string to its catalog spec, or null when not found / catalog
 * unavailable. Adds a catalog-specific reverse-prefix pass so a short canonical
 * id (e.g. "claude-3-5-sonnet") matches a dated catalog id
 * ("claude-3-5-sonnet-20241022") on a token boundary.
 */
export function getCatalogSpec(model: string): CatalogSpec | null {
  if (!model || typeof model !== "string") return null;
  if (lookupCache.has(model)) return lookupCache.get(model) ?? null;

  ensureLoaded();
  if (!catalogIndex || catalogKeys.length === 0) {
    lookupCache.set(model, null);
    return null;
  }

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

  const result = key ? catalogIndex.get(key) ?? null : null;
  lookupCache.set(model, result);
  return result;
}

/** Test-only: clear cached catalog so the next lookup reloads. */
export function __resetModelCatalog(): void {
  catalogIndex = null;
  catalogKeys = [];
  loadAttempted = false;
  lookupCache.clear();
}
