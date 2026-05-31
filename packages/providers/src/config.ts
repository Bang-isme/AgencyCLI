import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import type { AgencyConfig, ProviderProfile } from "./types.js";

const providerIdSchema = z.string();

const providerProfileSchema = z.object({
  apiKey: z.string().optional(),
  baseUrl: z.string().optional(),
  model: z.string().optional(),
  thinking: z.union([z.number(), z.string()]).optional(),
});

const agencyConfigSchema = z.object({
  defaultProvider: providerIdSchema.default("anthropic"),
  providers: z
    .record(providerIdSchema, providerProfileSchema)
    .optional()
    .default({}),
  modelOverrides: z
    .record(
      z.string(),
      z.object({
        contextWindow: z.number().optional(),
        maxOutputTokens: z.number().optional(),
        thinkingType: z.enum(["budget", "effort", "none"]).optional(),
      })
    )
    .optional(),
});

const DEFAULT_CONFIG: AgencyConfig = {
  defaultProvider: "anthropic",
  providers: {},
  modelOverrides: {},
};

export function resolveApiKey(profile?: ProviderProfile): string | undefined {
  if (!profile?.apiKey) return undefined;
  return profile.apiKey.replace(
    /\$\{([A-Z0-9_]+)\}/g,
    (_, name: string) => process.env[name] ?? ""
  );
}

// mtime-keyed cache so the hot path (loadAgencyConfig is called on every LLM
// request to read thinking settings) doesn't re-read + re-validate the file
// from disk each time. Automatically invalidated when the file changes on disk.
interface ConfigCacheEntry {
  mtimeMs: number;
  size: number;
  config: AgencyConfig;
}
const configCache = new Map<string, ConfigCacheEntry>();

function cloneConfig(cfg: AgencyConfig): AgencyConfig {
  return {
    defaultProvider: cfg.defaultProvider,
    providers: { ...cfg.providers },
    modelOverrides: cfg.modelOverrides ? { ...cfg.modelOverrides } : {},
  };
}

/** Drop the in-memory config cache (call after writing the config file). */
export function invalidateConfigCache(): void {
  configCache.clear();
}

/** Absolute path to the global config file (`~/.agency/config.json`). */
export function configFilePath(): string {
  return join(homedir(), ".agency", "config.json");
}

/**
 * Persist the full config to disk atomically (temp file + rename) so an
 * interrupted write can never leave a half-written config.json. The single
 * write path shared by the CLI (`config set`) and the TUI (`/connect`).
 */
export function saveAgencyConfig(config: AgencyConfig, configPath?: string): void {
  const path = configPath ?? configFilePath();
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tmpPath = `${path}.${process.pid}.tmp`;
  writeFileSync(tmpPath, `${JSON.stringify(config, null, 2)}\n`);
  renameSync(tmpPath, path);
  invalidateConfigCache();
}

export function loadAgencyConfig(configPath?: string): AgencyConfig {
  const path = configPath ?? join(homedir(), ".agency", "config.json");

  let stat: { mtimeMs: number; size: number } | undefined;
  try {
    const s = statSync(path);
    stat = { mtimeMs: s.mtimeMs, size: s.size };
  } catch {
    // File missing/unreadable — clear any stale cache entry and use defaults.
    configCache.delete(path);
    return cloneConfig(DEFAULT_CONFIG);
  }

  const cached = configCache.get(path);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
    return cloneConfig(cached.config);
  }

  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    if (raw.default && !raw.defaultProvider) {
      raw.defaultProvider = raw.default;
    }
    const parsed = agencyConfigSchema.safeParse(raw);
    if (!parsed.success) return cloneConfig(DEFAULT_CONFIG);
    const config: AgencyConfig = {
      defaultProvider: parsed.data.defaultProvider,
      providers: parsed.data.providers,
      modelOverrides: parsed.data.modelOverrides,
    };
    configCache.set(path, { mtimeMs: stat.mtimeMs, size: stat.size, config });
    return cloneConfig(config);
  } catch {
    return cloneConfig(DEFAULT_CONFIG);
  }
}

export function updateModelOverride(
  model: string,
  override: Partial<import("./types.js").ModelOverride>
): void {
  const dir = join(homedir(), ".agency");
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const cfgPath = join(dir, "config.json");
  let cfg: any = {};
  try {
    cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
  } catch {}

  if (!cfg.modelOverrides) cfg.modelOverrides = {};
  const existing = cfg.modelOverrides[model] ?? {};
  cfg.modelOverrides[model] = {
    ...existing,
    ...override,
  };

  // Atomic write: write to a temp file then rename, so an interrupted write
  // (Ctrl+C, power loss) can never leave a half-written / corrupt config.json.
  const tmpPath = `${cfgPath}.${process.pid}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(cfg, null, 2));
  renameSync(tmpPath, cfgPath);
  invalidateConfigCache();
}
