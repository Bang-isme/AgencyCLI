export type {
  AgencyConfig,
  ChatMessage,
  CompleteOptions,
  LlmProvider,
  ProviderId,
  ProviderProfile,
} from "./types.js";

export {
  loadAgencyConfig,
  resolveApiKey,
  updateModelOverride,
  saveAgencyConfig,
  configFilePath,
  invalidateConfigCache,
} from "./config.js";
export { createOpenAiCompatibleProvider } from "./adapters/openai-compatible.js";
export { createOpenAiProvider } from "./openai.js";
export { createAnthropicProvider } from "./anthropic.js";
export { createGoogleProvider } from "./google.js";
export { createOpenRouterProvider } from "./openrouter.js";
export { createNvidiaProvider } from "./nvidia.js";
export { createLocalProvider } from "./local.js";
export { createProvider, getProvider } from "./registry.js";
export {
  listProviderModels,
  listAllModels,
  type ModelInfo,
} from "./models.js";
export {
  getModelThinkingConfig,
  getModelSpec,
  resolveModelSpec,
  getRegisteredContextWindow,
  VARIANT_PERCENTAGES,
  MODEL_REGISTRY,
  type ModelThinkingConfig,
  type ModelSpec,
  type ThinkingVariant,
} from "./thinking-spec.js";
export {
  setModelCatalogEnabled,
  isModelCatalogEnabled,
  getCatalogSpec,
  matchModelKey,
  type CatalogSpec,
  type CatalogCapabilities,
} from "./model-catalog.js";
export {
  SmartRateLimiter,
  type RateLimitConfig,
  type RateLimitUtilization,
} from "./rate-limiter.js";
export {
  optimizeForTask,
  detectFlop,
  inferTaskIntent,
  type TaskIntent,
  type TokenOptimization,
  type OutputQualitySignals,
  type FlopAnalysis,
} from "./token-optimizer.js";

export { probeModel, type ProbeResult } from "./probe.js";
export {
  isContextLimitError,
  parseContextLimit,
  estimateMessagesTokens,
} from "./error-parser.js";
export { isTransientError } from "./utils/errors.js";




