import { createOpenAiCompatibleProvider } from "./adapters/openai-compatible.js";
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

const DEFAULT_GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta";
const DEFAULT_MODEL = "gemini-2.0-flash";

function toGeminiContents(messages: ChatMessage[]) {
  const system = messages.find((m) => m.role === "system")?.content;
  const contents = messages
    .filter((m) => m.role !== "system")
    .map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content }],
    }));
  return { system, contents };
}

async function parseGoogleLlmError(response: Response): Promise<Error> {
  const text = await response.text();
  try {
    const json = JSON.parse(text);
    const errorObj = json?.error || json;
    const msg = errorObj?.message || json?.message;
    const status = errorObj?.status || json?.status;

    if (
      response.status === 429 ||
      status === "RESOURCE_EXHAUSTED" ||
      text.includes("Quota exceeded") ||
      text.includes("RESOURCE_EXHAUSTED")
    ) {
      return new Error(
        `Your Google Gemini API key has exceeded its quota (RESOURCE_EXHAUSTED). On the free tier, this can occur if limits are exceeded or if the key was created via GCP Console instead of Google AI Studio (which has a limit of 0 for the free tier unless billing is attached). Please verify your API key at https://aistudio.google.com/.`
      );
    }

    if (response.status === 400 && msg?.includes("API key not valid")) {
      return new Error(
        `Invalid Google Gemini API key. Please check your credentials in config.json.`
      );
    }

    if (msg) {
      return new Error(`Google Gemini API error: ${msg}`);
    }
  } catch {
    // not JSON
  }
  return new Error(`Google Gemini API error ${response.status}: ${text}`);
}

export function createGoogleProvider(
  profile: ProviderProfile = {},
  fetchImpl?: typeof fetch
): LlmProvider {
  if (profile.baseUrl) {
    return createOpenAiCompatibleProvider({
      id: "google",
      apiKey: profile.apiKey,
      baseUrl: profile.baseUrl,
      defaultModel: profile.model ?? DEFAULT_MODEL,
      fetchImpl,
    });
  }

  const doFetch = fetchImpl ?? globalThis.fetch;
  const model = profile.model ?? DEFAULT_MODEL;

  const spec = getModelSpec(model);
  const limiter = new SmartRateLimiter({
    rpm: spec.freeRateLimit?.rpm ?? 60,
    tpm: spec.freeRateLimit?.tpm ?? 0,
  });

  return {
    id: "google",
    async complete(
      messages: ChatMessage[],
      opts?: CompleteOptions
    ): Promise<string> {
      const apiKey = profile.apiKey;
      if (!apiKey) {
        throw new Error("google provider requires apiKey");
      }

      return limiter.retryWithBackoff(async () => {
        const { system, contents } = toGeminiContents(messages);

        const currentModel = opts?.model ?? model;
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

        let maxOutputTokens = opts?.maxTokens;
        if (maxOutputTokens === undefined) {
          maxOutputTokens = optimization.maxOutputTokens;
        } else {
          maxOutputTokens = Math.min(maxOutputTokens, optimization.maxOutputTokens);
        }

        let temperature = opts?.temperature;
        if (temperature === undefined && optimization.temperature !== null) {
          temperature = optimization.temperature;
        }

        const generationConfig: Record<string, any> = {
          maxOutputTokens,
          temperature,
        };

        if (modelSpec.thinkingType === "budget" && optimization.thinkingBudget !== null) {
          const budget = optimization.thinkingBudget;
          if (budget > 0) {
            generationConfig.thinkingConfig = {
              thinkingBudget: budget,
            };
          }
        }

        const body: Record<string, unknown> = {
          contents,
          generationConfig,
        };
        if (system) body.systemInstruction = { parts: [{ text: system }] };

        const url = `${DEFAULT_GEMINI_BASE}/models/${currentModel}:generateContent?key=${encodeURIComponent(apiKey)}`;
        const timeoutSignal = AbortSignal.timeout(120_000);
        const reqSignal = opts?.signal
          ? AbortSignal.any([opts.signal, timeoutSignal])
          : timeoutSignal;
        const res = await doFetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: reqSignal,
        });

        if (!res.ok) {
          throw await parseGoogleLlmError(res);
        }

        const data = (await res.json()) as {
          candidates?: Array<{
            content?: { parts?: Array<{ text?: string; thought?: boolean }> };
            finishReason?: string;
          }>;
          usageMetadata?: { promptTokenCount: number; candidatesTokenCount: number; totalTokenCount: number };
        };

        const parts = data.candidates?.[0]?.content?.parts ?? [];
        let fullThought = "";
        let fullText = "";

        for (const part of parts) {
          if (part.thought) {
            const thoughtPiece = part.text ?? "";
            fullThought += thoughtPiece;
            if (thoughtPiece && opts?.onThought) {
              opts.onThought(thoughtPiece);
            }
          } else {
            fullText += part.text ?? "";
          }
        }

        if (data.candidates?.[0]?.finishReason && opts?.onFinishReason) {
          opts.onFinishReason(data.candidates[0].finishReason);
        }

        if (data.usageMetadata && opts?.onUsage) {
          opts.onUsage({
            promptTokens: data.usageMetadata.promptTokenCount,
            completionTokens: data.usageMetadata.candidatesTokenCount,
          });
        }

        limiter.recordUsage(Math.ceil(fullText.length / 4));
        return fullText;
      });
    },

    async streamComplete(
      messages: ChatMessage[],
      opts: StreamCompleteOptions
    ): Promise<string> {
      const apiKey = profile.apiKey;
      if (!apiKey) {
        throw new Error("google provider requires apiKey");
      }

      return limiter.retryWithBackoff(async () => {
        const { system, contents } = toGeminiContents(messages);

        const currentModel = opts?.model ?? model;
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

        let maxOutputTokens = opts?.maxTokens;
        if (maxOutputTokens === undefined) {
          maxOutputTokens = optimization.maxOutputTokens;
        } else {
          maxOutputTokens = Math.min(maxOutputTokens, optimization.maxOutputTokens);
        }

        let temperature = opts?.temperature;
        if (temperature === undefined && optimization.temperature !== null) {
          temperature = optimization.temperature;
        }

        const generationConfig: Record<string, any> = {
          maxOutputTokens,
          temperature,
        };

        if (modelSpec.thinkingType === "budget" && optimization.thinkingBudget !== null) {
          const budget = optimization.thinkingBudget;
          if (budget > 0) {
            generationConfig.thinkingConfig = {
              thinkingBudget: budget,
            };
          }
        }

        const body: Record<string, unknown> = {
          contents,
          generationConfig,
        };
        if (system) body.systemInstruction = { parts: [{ text: system }] };

        // Gemini REST streaming endpoint is :streamGenerateContent
        const url = `${DEFAULT_GEMINI_BASE}/models/${currentModel}:streamGenerateContent?key=${encodeURIComponent(apiKey)}`;
        const res = await doFetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: opts.signal,
        });

        if (!res.ok) {
          throw await parseGoogleLlmError(res);
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

        let braceCount = 0;
        let startIdx = -1;

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          let i = 0;
          while (i < buffer.length) {
            const char = buffer[i];
            if (char === "{") {
              if (braceCount === 0) {
                startIdx = i;
              }
              braceCount++;
            } else if (char === "}") {
              braceCount--;
              if (braceCount === 0 && startIdx !== -1) {
                const jsonStr = buffer.slice(startIdx, i + 1);
                try {
                  const data = JSON.parse(jsonStr) as {
                    candidates?: Array<{
                      content?: { parts?: Array<{ text?: string; thought?: boolean }> };
                      finishReason?: string;
                    }>;
                    usageMetadata?: { promptTokenCount: number; candidatesTokenCount: number; totalTokenCount: number };
                  };

                  const parts = data.candidates?.[0]?.content?.parts ?? [];
                  for (const part of parts) {
                    if (part.thought) {
                      const thoughtPiece = part.text ?? "";
                      if (thoughtPiece) {
                        fullThought += thoughtPiece;
                        opts.onThought?.(thoughtPiece);
                      }
                    } else {
                      const textPiece = part.text ?? "";
                      if (textPiece) {
                        fullText += textPiece;
                        opts.onDelta(textPiece);
                      }
                    }
                  }

                  if (data.candidates?.[0]?.finishReason && opts.onFinishReason) {
                    opts.onFinishReason(data.candidates[0].finishReason);
                  }

                  if (data.usageMetadata && opts.onUsage) {
                    opts.onUsage({
                      promptTokens: data.usageMetadata.promptTokenCount,
                      completionTokens: data.usageMetadata.candidatesTokenCount,
                    });
                  }
                } catch {
                  // ignore malformed or incomplete brace matching json frames
                }
                buffer = buffer.slice(i + 1);
                i = -1; // reset index scanner
                startIdx = -1;
              }
            }
            i++;
          }
        }

        limiter.recordUsage(Math.ceil(fullText.length / 4));
        return fullText;
      });
    },
  };
}
