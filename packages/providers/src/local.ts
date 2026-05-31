import { createOpenAiCompatibleProvider } from "./adapters/openai-compatible.js";
import type { LlmProvider, ProviderProfile } from "./types.js";

const DEFAULT_BASE_URL = "http://localhost:11434/v1";
const DEFAULT_MODEL = "llama3.2";

export function createLocalProvider(
  profile: ProviderProfile = {},
  fetchImpl?: typeof fetch
): LlmProvider {
  return createOpenAiCompatibleProvider({
    id: "local",
    apiKey: profile.apiKey,
    baseUrl: profile.baseUrl ?? DEFAULT_BASE_URL,
    defaultModel: profile.model ?? DEFAULT_MODEL,
    fetchImpl,
    // Local-first tuning: local servers (Ollama/LM Studio/vLLM) have no quota,
    // so we never need short timeouts — but a cold model load can take minutes,
    // so we rely on an idle-timeout (silence between tokens) rather than a hard
    // total cap. autoDetectModel makes the CLI work even when the user pulled a
    // model under a different name than the configured default.
    timeoutMs: 600_000,
    idleTimeoutMs: 120_000,
    autoDetectModel: true,
  });
}
