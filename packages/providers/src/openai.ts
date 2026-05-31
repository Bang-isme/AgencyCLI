import { createOpenAiCompatibleProvider } from "./adapters/openai-compatible.js";
import type { LlmProvider, ProviderProfile } from "./types.js";

const DEFAULT_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_MODEL = "gpt-4o-mini";

export function createOpenAiProvider(
  profile: ProviderProfile = {},
  fetchImpl?: typeof fetch
): LlmProvider {
  return createOpenAiCompatibleProvider({
    id: "openai",
    apiKey: profile.apiKey,
    baseUrl: profile.baseUrl ?? DEFAULT_BASE_URL,
    defaultModel: profile.model ?? DEFAULT_MODEL,
    fetchImpl,
  });
}
