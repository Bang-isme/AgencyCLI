/**
 * One-shot catalog cleaner: strips external-vendor/SDK pointer fields from
 * models.json so the catalog is Agency-exclusive. The model-catalog loader
 * (packages/providers/src/model-catalog.ts) reads ONLY each provider's `.models`
 * object and, per model, `limit`/`cost`/`tool_call`/`temperature`/`reasoning`/
 * `attachment`/`modalities`. The `npm` (e.g. "@ai-sdk/openai-compatible"), `api`,
 * `doc`, and `env` fields — at the provider level AND inside per-model `provider`
 * overrides — are dead metadata inherited from the models.dev source format.
 *
 * Strips those keys recursively (wherever they appear) and removes any `provider`
 * sub-object left empty as a result. Idempotent; re-run after a catalog re-sync.
 *   node scripts/strip-external-refs.mjs
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const path = join(root, "packages", "providers", "models.json");
// `npm`/`api`/`doc`/`env` = external SDK/vendor pointers. `provider` = per-model
// request-shape overrides (vendor body/headers/shape hints) the loader ignores.
// Top-level providers are keyed by their id (e.g. "anthropic"), never under a
// "provider" key, so deleting every "provider" key is safe.
const STRIP = new Set(["npm", "api", "doc", "env", "provider"]);

const catalog = JSON.parse(readFileSync(path, "utf8"));
const removed = {};

function clean(node) {
  if (Array.isArray(node)) {
    for (const item of node) clean(item);
    return;
  }
  if (!node || typeof node !== "object") return;
  for (const key of Object.keys(node)) {
    if (STRIP.has(key)) {
      delete node[key];
      removed[key] = (removed[key] ?? 0) + 1;
    } else if (node[key] && typeof node[key] === "object") {
      clean(node[key]);
    }
  }
}

clean(catalog);
writeFileSync(path, JSON.stringify(catalog, null, 4) + "\n");
console.log(`Stripped external refs from ${Object.keys(catalog).length} providers:`, removed);
