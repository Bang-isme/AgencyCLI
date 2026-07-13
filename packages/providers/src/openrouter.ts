import { createOpenAiCompatibleProvider } from "./adapters/openai-compatible.js";
import type { LlmProvider, ProviderProfile, Transport } from "./types.js";

const DEFAULT_BASE_URL = "https://openrouter.ai/api/v1";
const DEFAULT_MODEL = "openai/gpt-4o-mini";

export function createOpenRouterProvider(
  profile: ProviderProfile = {},
  transport?: Transport
): LlmProvider {
  return createOpenAiCompatibleProvider({
    id: "openrouter",
    apiKey: profile.apiKey,
    baseUrl: profile.baseUrl ?? DEFAULT_BASE_URL,
    defaultModel: profile.model ?? DEFAULT_MODEL,
    transport,
    extraHeaders: {
      "HTTP-Referer": "https://agency-cli.local",
      "X-Title": "Agency CLI",
    },
  });
}

