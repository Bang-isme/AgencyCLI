import { resolveApiKey } from "./config.js";
import { createAnthropicProvider } from "./anthropic.js";
import { createGoogleProvider } from "./google.js";
import { createLocalProvider } from "./local.js";
import { createNvidiaProvider } from "./nvidia.js";
import { createOpenAiProvider } from "./openai.js";
import { createOpenRouterProvider } from "./openrouter.js";
import { createOpenAiCompatibleProvider } from "./adapters/openai-compatible.js";
import type { AgencyConfig, LlmProvider, ProviderId } from "./types.js";

type ProviderFactory = (
  profile: { apiKey?: string; baseUrl?: string; model?: string },
  fetchImpl?: typeof fetch
) => LlmProvider;

const FACTORIES: Record<string, ProviderFactory> = {
  openai: createOpenAiAiCompatibleProviderShim(createOpenAiProvider),
  anthropic: createAnthropicProvider,
  google: createGoogleProvider,
  openrouter: createOpenRouterProvider,
  nvidia: createNvidiaProvider,
  local: createLocalProvider,
};

// Helper shim because some factory types may differ slightly
function createOpenAiAiCompatibleProviderShim(factory: any): ProviderFactory {
  return factory;
}

export function createProvider(
  id: ProviderId,
  config: AgencyConfig,
  fetchImpl?: typeof fetch
): LlmProvider {
  const profile = config.providers[id] ?? {};
  const resolved = {
    ...profile,
    apiKey: resolveApiKey(profile),
  };
  const factory = FACTORIES[id];
  if (factory) {
    return factory(resolved, fetchImpl);
  }

  if (!resolved.baseUrl) {
    throw new Error(
      `Custom provider "${id}" must configure a "baseUrl" in ~/.agency/config.json.`
    );
  }
  return createOpenAiCompatibleProvider({
    id,
    apiKey: resolved.apiKey,
    baseUrl: resolved.baseUrl,
    defaultModel: resolved.model ?? "gpt-4o",
    fetchImpl,
  });
}

export function getProvider(
  config: AgencyConfig,
  overrideId?: ProviderId,
  fetchImpl?: typeof fetch
): LlmProvider {
  const id = overrideId ?? config.defaultProvider;
  return createProvider(id, config, fetchImpl);
}
