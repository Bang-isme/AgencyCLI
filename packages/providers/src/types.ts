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
