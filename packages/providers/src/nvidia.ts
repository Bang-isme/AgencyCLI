import { createOpenAiCompatibleProvider } from "./adapters/openai-compatible.js";
import type { LlmProvider, ProviderProfile } from "./types.js";

const DEFAULT_BASE_URL = "https://integrate.api.nvidia.com/v1";
const DEFAULT_MODEL = "meta/llama3-70b-instruct";

export function createNvidiaProvider(
  profile: ProviderProfile = {},
  fetchImpl?: typeof fetch
): LlmProvider {
  return createOpenAiCompatibleProvider({
    id: "nvidia",
    apiKey: profile.apiKey,
    baseUrl: profile.baseUrl ?? DEFAULT_BASE_URL,
    defaultModel: profile.model ?? DEFAULT_MODEL,
    fetchImpl,
  });
}
