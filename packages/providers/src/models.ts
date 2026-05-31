/**
 * Fetch available models from a provider's API endpoint.
 * Each provider adapter can implement this to call their /models endpoint.
 */

import { loadAgencyConfig, resolveApiKey } from "./config.js";
import type { ProviderId, ProviderProfile } from "./types.js";

export interface ModelInfo {
  id: string;
  name: string;
  contextWindow?: number;
  provider: ProviderId;
}

interface ModelsResponse {
  data?: Array<{ id: string; [key: string]: unknown }>;
  models?: Array<{ id: string; [key: string]: unknown }>;
}

const PROVIDER_ENDPOINTS: Record<ProviderId, string | null> = {
  openai: "https://api.openai.com/v1/models",
  anthropic: null, // Anthropic doesn't have a /models endpoint, use hardcoded
  google: null, // Use hardcoded
  openrouter: "https://openrouter.ai/api/v1/models",
  nvidia: "https://integrate.api.nvidia.com/v1/models",
  local: "http://localhost:11434/api/tags",
};

const ANTHROPIC_MODELS: ModelInfo[] = [
  { id: "claude-sonnet-4-20250514", name: "Claude Sonnet 4", contextWindow: 200_000, provider: "anthropic" },
  { id: "claude-3-5-sonnet-20241022", name: "Claude 3.5 Sonnet", contextWindow: 200_000, provider: "anthropic" },
  { id: "claude-3-opus-20240229", name: "Claude 3 Opus", contextWindow: 200_000, provider: "anthropic" },
  { id: "claude-3-5-haiku-20241022", name: "Claude 3.5 Haiku", contextWindow: 200_000, provider: "anthropic" },
];

const GOOGLE_MODELS: ModelInfo[] = [
  { id: "gemini-2.5-pro", name: "Gemini 2.5 Pro", contextWindow: 1_000_000, provider: "google" },
  { id: "gemini-2.0-flash", name: "Gemini 2.0 Flash", contextWindow: 1_000_000, provider: "google" },
  { id: "gemini-2.5-flash", name: "Gemini 2.5 Flash", contextWindow: 1_000_000, provider: "google" },
];

function extractModelName(id: string): string {
  // Clean up model IDs to human-readable names
  const base = id.split("/").pop() ?? id;
  return base
    .replace(/[-_]/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .slice(0, 40);
}

async function fetchModelsFromEndpoint(
  url: string,
  apiKey: string,
  provider: ProviderId,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<ModelInfo[]> {
  try {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };

    if (apiKey) {
      headers["Authorization"] = `Bearer ${apiKey}`;
    }

    const res = await fetchImpl(url, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) return [];

    const json = (await res.json()) as ModelsResponse;

    // OpenAI/OpenRouter/NVIDIA format: { data: [...] }
    if (json.data && Array.isArray(json.data)) {
      return json.data
        .filter((m) => typeof m.id === "string")
        .map((m) => {
          const raw = m as Record<string, unknown>;
          const contextLength =
            raw.context_length ??
            raw.context_window ??
            raw.max_position_embeddings ??
            raw.max_context_length ??
            raw.contextWindow;
          return {
            id: m.id,
            name: extractModelName(m.id),
            contextWindow: typeof contextLength === "number" ? contextLength : undefined,
            provider,
          };
        })
        .slice(0, 300); // cap at 300 models to allow full list of OpenRouter/NVIDIA models
    }

    // Ollama format: { models: [...] }
    if (json.models && Array.isArray(json.models)) {
      return json.models.map((m) => ({
        id: (m as Record<string, unknown>).name as string ?? m.id,
        name: extractModelName((m as Record<string, unknown>).name as string ?? m.id),
        provider,
      }));
    }

    return [];
  } catch {
    return [];
  }
}

/**
 * List available models for a given provider.
 * Calls the provider's API /models endpoint if available,
 * or returns hardcoded models for providers that don't support it.
 */
export async function listProviderModels(
  providerId: ProviderId,
  profile?: ProviderProfile,
  fetchImpl?: typeof fetch,
): Promise<ModelInfo[]> {
  // Hardcoded providers
  if (providerId === "anthropic") return ANTHROPIC_MODELS;
  if (providerId === "google") return GOOGLE_MODELS;

  let endpoint = PROVIDER_ENDPOINTS[providerId as keyof typeof PROVIDER_ENDPOINTS];
  if (!endpoint) {
    if (profile?.baseUrl) {
      const base = profile.baseUrl.replace(/\/$/, "");
      endpoint = `${base}/models`;
    } else {
      return [];
    }
  }

  const apiKey = resolveApiKey(profile);
  const isBuiltInRemote = ["openai", "openrouter", "nvidia"].includes(providerId);
  if (!apiKey && isBuiltInRemote) return [];

  let fetched: ModelInfo[] = [];

  // Local/Ollama doesn't need auth
  if (providerId === "local") {
    let localEndpoint = endpoint;
    if (profile?.baseUrl) {
      const base = profile.baseUrl.replace(/\/v1\/?$/, "").replace(/\/$/, "");
      localEndpoint = `${base}/api/tags`;
    }
    fetched = await fetchModelsFromEndpoint(localEndpoint, "", providerId, fetchImpl);
  } else {
    fetched = await fetchModelsFromEndpoint(endpoint, apiKey ?? "", providerId, fetchImpl);
  }

  // Ensure the user's custom-configured model is always in the list as a fallback
  if (profile?.model) {
    const exists = fetched.some((m) => m.id === profile.model);
    if (!exists) {
      return [
        {
          id: profile.model,
          name: extractModelName(profile.model),
          provider: providerId,
        },
        ...fetched,
      ];
    }
  }

  return fetched;
}

/**
 * List all available models across all configured providers.
 */
export async function listAllModels(
  fetchImpl?: typeof fetch,
): Promise<ModelInfo[]> {
  const config = loadAgencyConfig();
  const builtIns = ["anthropic", "openai", "google", "openrouter", "nvidia", "local"];
  const configured = Object.keys(config.providers);
  const providers = Array.from(new Set([...builtIns, ...configured]));

  const results = await Promise.allSettled(
    providers.map(async (id) => {
      const profile = config.providers[id];
      const key = resolveApiKey(profile);
      const isBuiltInRemote = ["openai", "openrouter", "nvidia"].includes(id);
      if (!key && isBuiltInRemote) return [];
      return listProviderModels(id, profile, fetchImpl);
    })
  );

  return results.flatMap((r) => (r.status === "fulfilled" ? r.value : []));
}
