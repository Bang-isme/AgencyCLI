import { getModelSpec } from "./thinking-spec.js";
import { SmartRateLimiter } from "./rate-limiter.js";
import { inferTaskIntent, optimizeForTask } from "./token-optimizer.js";
import type {
  ChatMessage,
  CompleteOptions,
  LlmProvider,
  ProviderProfile,
  StreamCompleteOptions,
} from "./types.js";

const DEFAULT_BASE_URL = "https://api.anthropic.com/v1";
const DEFAULT_MODEL = "claude-3-5-sonnet-20241022";
const ANTHROPIC_VERSION = "2023-06-01";

function splitMessages(messages: ChatMessage[]) {
  const system = messages.find((m) => m.role === "system")?.content;
  const conversation = messages
    .filter((m) => m.role !== "system")
    .map((m) => ({
      role: m.role === "assistant" ? ("assistant" as const) : ("user" as const),
      content: m.content,
    }));
  return { system, conversation };
}

export function createAnthropicProvider(
  profile: ProviderProfile = {},
  fetchImpl?: typeof fetch
): LlmProvider {
  const doFetch = fetchImpl ?? globalThis.fetch;
  const baseUrl = (profile.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
  const defaultModel = profile.model ?? DEFAULT_MODEL;

  const spec = getModelSpec(defaultModel);
  const limiter = new SmartRateLimiter({
    rpm: spec.freeRateLimit?.rpm ?? 60,
    tpm: spec.freeRateLimit?.tpm ?? 0,
  });

  return {
    id: "anthropic",
    async complete(
      messages: ChatMessage[],
      opts?: CompleteOptions
    ): Promise<string> {
      const apiKey = profile.apiKey;
      if (!apiKey) {
        throw new Error("anthropic provider requires apiKey");
      }

      return limiter.retryWithBackoff(async () => {
        const { system, conversation } = splitMessages(messages);

        const currentModel = opts?.model ?? defaultModel;
        const modelSpec = getModelSpec(currentModel);
        const lastPrompt = messages[messages.length - 1]?.content ?? "";
        const intent = inferTaskIntent(lastPrompt);
        const optimization = optimizeForTask(intent, modelSpec, profile.thinking);

        if (opts?.onOptimization) {
          opts.onOptimization({
            budget: optimization.thinkingBudget ?? 0,
            intent,
            type: modelSpec.thinkingType,
          });
        }

        let maxTokens = opts?.maxTokens ?? 1024;
        if (optimization.maxOutputTokens) {
          maxTokens = Math.min(maxTokens, optimization.maxOutputTokens);
        }

        let temperature = opts?.temperature;
        if (temperature === undefined && optimization.temperature !== null) {
          temperature = optimization.temperature;
        }

        const body: Record<string, any> = {
          model: currentModel,
          max_tokens: maxTokens,
          messages: conversation,
        };
        if (system) body.system = system;
        if (temperature !== undefined) body.temperature = temperature;

        if (modelSpec.thinkingType === "budget" && optimization.thinkingBudget !== null) {
          const budgetTokens = optimization.thinkingBudget;
          if (budgetTokens > 0) {
            body.thinking = {
              type: "enabled",
              budget_tokens: budgetTokens,
            };
            // thinking budget requires max_tokens to be larger than budget_tokens
            body.max_tokens = Math.max(body.max_tokens, budgetTokens + 1024);
            // Anthropic API requires no temperature when thinking is enabled
            delete body.temperature;
          }
        }

        // Combine caller cancellation with a hard timeout so a hung connection
        // can't block the CLI indefinitely.
        const timeoutSignal = AbortSignal.timeout(120_000);
        const reqSignal = opts?.signal
          ? AbortSignal.any([opts.signal, timeoutSignal])
          : timeoutSignal;

        const res = await doFetch(`${baseUrl}/messages`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": apiKey,
            "anthropic-version": ANTHROPIC_VERSION,
          },
          body: JSON.stringify(body),
          signal: reqSignal,
        });

        if (!res.ok) {
          const text = await res.text();
          throw new Error(`anthropic API error ${res.status}: ${text}`);
        }

        const data = (await res.json()) as {
          content?: Array<{ type?: string; text?: string; thinking?: string }>;
          usage?: { input_tokens: number; output_tokens: number };
          stop_reason?: string;
        };

        const thinkingBlock = data.content?.find((block) => block.type === "thinking");
        if (thinkingBlock && thinkingBlock.thinking && opts?.onThought) {
          opts.onThought(thinkingBlock.thinking);
        }

        const text = data.content?.find((block) => block.type === "text")?.text;
        if (typeof text !== "string") {
          throw new Error("anthropic API returned no content");
        }

        if (data.stop_reason && opts?.onFinishReason) {
          opts.onFinishReason(data.stop_reason);
        }

        if (data.usage && opts?.onUsage) {
          opts.onUsage({
            promptTokens: data.usage.input_tokens,
            completionTokens: data.usage.output_tokens,
          });
        }

        limiter.recordUsage(Math.ceil(text.length / 4));
        return text;
      });
    },

    async streamComplete(
      messages: ChatMessage[],
      opts: StreamCompleteOptions
    ): Promise<string> {
      const apiKey = profile.apiKey;
      if (!apiKey) {
        throw new Error("anthropic provider requires apiKey");
      }

      return limiter.retryWithBackoff(async () => {
        const { system, conversation } = splitMessages(messages);

        const currentModel = opts.model ?? defaultModel;
        const modelSpec = getModelSpec(currentModel);
        const lastPrompt = messages[messages.length - 1]?.content ?? "";
        const intent = inferTaskIntent(lastPrompt);
        const optimization = optimizeForTask(intent, modelSpec, profile.thinking);

        if (opts.onOptimization) {
          opts.onOptimization({
            budget: optimization.thinkingBudget ?? 0,
            intent,
            type: modelSpec.thinkingType,
          });
        }

        let maxTokens = opts.maxTokens ?? 1024;
        if (optimization.maxOutputTokens) {
          maxTokens = Math.min(maxTokens, optimization.maxOutputTokens);
        }

        let temperature = opts.temperature;
        if (temperature === undefined && optimization.temperature !== null) {
          temperature = optimization.temperature;
        }

        const body: Record<string, any> = {
          model: currentModel,
          max_tokens: maxTokens,
          messages: conversation,
          stream: true,
        };
        if (system) body.system = system;
        if (temperature !== undefined) body.temperature = temperature;

        if (modelSpec.thinkingType === "budget" && optimization.thinkingBudget !== null) {
          const budgetTokens = optimization.thinkingBudget;
          if (budgetTokens > 0) {
            body.thinking = {
              type: "enabled",
              budget_tokens: budgetTokens,
            };
            body.max_tokens = Math.max(body.max_tokens, budgetTokens + 1024);
            delete body.temperature;
          }
        }

        const res = await doFetch(`${baseUrl}/messages`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": apiKey,
            "anthropic-version": ANTHROPIC_VERSION,
          },
          body: JSON.stringify(body),
          signal: opts.signal,
        });

        if (!res.ok) {
          const text = await res.text();
          throw new Error(`anthropic API error ${res.status}: ${text}`);
        }

        if (!res.body) {
          const full = await this.complete(messages, opts);
          opts.onDelta(full);
          return full;
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let fullThought = "";
        let fullText = "";

        let promptTokens = 0;
        let completionTokens = 0;

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith("data:")) continue;
            const payload = trimmed.slice(5).trim();
            if (!payload) continue;

            try {
              const event = JSON.parse(payload) as {
                type: string;
                message?: { usage?: { input_tokens?: number } };
                content_block?: { type?: string };
                delta?: { type?: string; text?: string; thinking?: string; stop_reason?: string };
                usage?: { output_tokens?: number };
              };

              if (event.type === "message_start" && event.message?.usage?.input_tokens) {
                promptTokens = event.message.usage.input_tokens;
              } else if (event.type === "content_block_delta" && event.delta) {
                if (event.delta.type === "thinking_delta" && event.delta.thinking) {
                  const chunk = event.delta.thinking;
                  fullThought += chunk;
                  opts.onThought?.(chunk);
                } else if (event.delta.type === "text_delta" && event.delta.text) {
                  const chunk = event.delta.text;
                  fullText += chunk;
                  opts.onDelta(chunk);
                }
              } else if (event.type === "message_delta") {
                if (event.usage?.output_tokens) {
                  completionTokens = event.usage.output_tokens;
                }
                if (event.delta?.stop_reason && opts.onFinishReason) {
                  opts.onFinishReason(event.delta.stop_reason);
                }
              }
            } catch {
              // ignore malformed SSE frames
            }
          }
        }

        if (opts.onUsage && promptTokens > 0) {
          opts.onUsage({
            promptTokens,
            completionTokens: completionTokens || Math.ceil(fullText.length / 4),
          });
        }

        limiter.recordUsage(Math.ceil(fullText.length / 4));
        return fullText;
      });
    },
  };
}
