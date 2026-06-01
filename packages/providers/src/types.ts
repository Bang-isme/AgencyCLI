export type ProviderId =
  | "openai"
  | "anthropic"
  | "google"
  | "openrouter"
  | "nvidia"
  | "local"
  | (string & {});

export interface ProviderProfile {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  thinking?: number | string;
}

export interface ModelOverride {
  contextWindow?: number;
  maxOutputTokens?: number;
  thinkingType?: "budget" | "effort" | "none";
}

export interface AgencyConfig {
  defaultProvider: ProviderId;
  providers: Partial<Record<ProviderId, ProviderProfile>>;
  modelOverrides?: Record<string, ModelOverride>;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface CompleteOptions {
  model?: string;
  maxTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
  /**
   * Ask the adapter to mark the (static-prefix) system prompt for provider-side
   * prompt caching. OpenAI-compatible servers cache a stable prefix
   * automatically and ignore this; the Anthropic adapter has no automatic
   * prefix cache, so it attaches `cache_control:{type:"ephemeral"}` to the
   * system block. Set by core from the `promptCachePrefix` flag. Roadmap §8.11-B.
   */
  cacheSystemPrompt?: boolean;
  onUsage?: (usage: { promptTokens: number; completionTokens: number; reasoningTokens?: number }) => void;
  onThought?: (thoughtDelta: string) => void;
  onFinishReason?: (reason: string) => void;
  onOptimization?: (optimization: { budget: number; intent: string; type: "budget" | "effort" | "none" }) => void;
}

export interface StreamCompleteOptions extends CompleteOptions {
  onDelta: (delta: string) => void;
}

export interface LlmProvider {
  id: ProviderId;
  complete(messages: ChatMessage[], opts?: CompleteOptions): Promise<string>;
  /** OpenAI-compatible SSE streaming when supported by the adapter. */
  streamComplete?(
    messages: ChatMessage[],
    opts: StreamCompleteOptions
  ): Promise<string>;
}
