import { loadAgencyConfig } from "../config.js";
import { getModelSpec } from "../thinking-spec.js";
import { SmartRateLimiter } from "../rate-limiter.js";
import { inferTaskIntent, optimizeForTask } from "../token-optimizer.js";
import type {
  ChatMessage,
  CompleteOptions,
  LlmProvider,
  ProviderId,
  StreamCompleteOptions,
} from "../types.js";

export interface OpenAiCompatibleOptions {
  id: ProviderId;
  apiKey?: string;
  baseUrl: string;
  defaultModel: string;
  fetchImpl?: typeof fetch;
  extraHeaders?: Record<string, string>;
  /**
   * Total timeout (ms) for a non-streaming request. 0 disables.
   * Default 120000 (2 min). Protects against a hung server (e.g. a frozen
   * local Ollama) blocking the CLI forever.
   */
  timeoutMs?: number;
  /**
   * Idle timeout (ms) for streaming requests: abort if no token arrives
   * within this window. Reset on every chunk. 0 disables. Default 90000.
   */
  idleTimeoutMs?: number;
  /**
   * When true, query `/models` and pick a usable model if the configured
   * default is not actually served (key local-first behaviour for Ollama,
   * LM Studio, vLLM, etc. where the installed model name varies per machine).
   */
  autoDetectModel?: boolean;
}

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_IDLE_TIMEOUT_MS = 90_000;

/**
 * Build an AbortSignal that fires when either the caller cancels (opts.signal)
 * or the timeout elapses. Returns a cleanup fn that MUST be called to clear the
 * timer and listeners (avoids leaks / dangling timers).
 */
function createTimeoutSignal(
  userSignal: AbortSignal | undefined,
  timeoutMs: number
): { signal: AbortSignal; cleanup: () => void; timedOut: () => boolean } {
  const controller = new AbortController();
  let didTimeout = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const onUserAbort = () => controller.abort((userSignal as any)?.reason);

  if (userSignal) {
    if (userSignal.aborted) {
      controller.abort((userSignal as any).reason);
    } else {
      userSignal.addEventListener("abort", onUserAbort, { once: true });
    }
  }

  if (timeoutMs > 0 && !controller.signal.aborted) {
    timer = setTimeout(() => {
      didTimeout = true;
      controller.abort(new Error(`request timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    // Don't keep the event loop alive purely for this timer.
    if (typeof (timer as any)?.unref === "function") (timer as any).unref();
  }

  return {
    signal: controller.signal,
    timedOut: () => didTimeout,
    cleanup: () => {
      if (timer) clearTimeout(timer);
      if (userSignal) userSignal.removeEventListener("abort", onUserAbort);
    },
  };
}

/**
 * Turn low-level fetch/connection failures into actionable messages.
 * Especially important for local-first UX: when Ollama / a local server is
 * down, Node's `fetch` throws an opaque "fetch failed" TypeError.
 */
function enrichConnectionError(err: unknown, id: string, baseUrl: string): Error {
  if (err instanceof Error && err.name === "AbortError") {
    return err;
  }
  const cause: any = (err as any)?.cause;
  const code = cause?.code ?? (err as any)?.code;
  const isConnRefused =
    code === "ECONNREFUSED" ||
    code === "ECONNRESET" ||
    code === "ENOTFOUND" ||
    code === "EAI_AGAIN" ||
    (err instanceof TypeError && /fetch failed/i.test(err.message));

  if (isConnRefused) {
    const isLocal = id === "local" || /(^|\/\/)(localhost|127\.0\.0\.1|0\.0\.0\.0)/.test(baseUrl);
    if (isLocal) {
      return new Error(
        `Cannot reach local LLM server at ${baseUrl}. Is it running? ` +
          `For Ollama: run "ollama serve" (and "ollama pull <model>"). ` +
          `For LM Studio / vLLM: start the server and confirm the port. ` +
          `Override the address with the "baseUrl" field in ~/.agency/config.json.`
      );
    }
    return new Error(
      `Cannot reach ${id} API at ${baseUrl} (${code ?? "network error"}). ` +
        `Check your internet connection, proxy/firewall settings, and the configured baseUrl.`
    );
  }
  return err instanceof Error ? err : new Error(String(err));
}

async function parseLlmError(id: string, response: Response): Promise<Error> {
  const text = await response.text();
  try {
    const json = JSON.parse(text);
    const errorObj = json?.error || json;
    const msg = errorObj?.message || json?.message;
    const code = errorObj?.code || json?.code;
    const metadataRaw = errorObj?.metadata?.raw;

    const isQuota =
      response.status === 402 ||
      response.status === 429 ||
      code === "insufficient_quota" ||
      text.toLowerCase().includes("quota") ||
      text.toLowerCase().includes("credits") ||
      text.toLowerCase().includes("exhausted") ||
      text.toLowerCase().includes("developer limit");

    if (isQuota) {
      if (id === "nvidia" || text.toLowerCase().includes("nvidia") || text.toLowerCase().includes("nvapi")) {
        return new Error(
          `Your NVIDIA NIM API key has reached its free tier developer limit or is out of credits. ` +
          `NVIDIA NIM free credits are strictly capped at 1000 requests. Please log in to your NVIDIA Build dashboard at ` +
          `https://build.nvidia.com/ to check your credit balance, monitor active rate limits, or top up your API quota.`
        );
      }
      const billingUrl = id === "openrouter" ? "https://openrouter.ai/dashboard/billing" : "the provider's billing dashboard";
      return new Error(`Your ${id} account has exceeded its quota or is out of credits. Please verify your balance and top up at ${billingUrl}.`);
    }

    if (msg) {
      if (metadataRaw) {
        try {
          const rawParsed = JSON.parse(metadataRaw);
          const rawMsg = rawParsed?.error?.message || rawParsed?.message || rawParsed;
          if (rawMsg) {
            return new Error(`${id} API error: ${msg} (${rawMsg})`);
          }
        } catch {}
        return new Error(`${id} API error: ${msg} (${metadataRaw})`);
      }
      return new Error(`${id} API error: ${msg}`);
    }
  } catch {
    // not JSON
  }
  return new Error(`${id} API error ${response.status}: ${text}`);
}

export function createOpenAiCompatibleProvider(
  options: OpenAiCompatibleOptions
): LlmProvider {
  const doFetch = options.fetchImpl ?? globalThis.fetch;
  const baseUrl = options.baseUrl.replace(/\/$/, "");
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  const autoDetect = options.autoDetectModel ?? false;

  const spec = getModelSpec(options.defaultModel);
  const limiter = new SmartRateLimiter({
    rpm: spec.freeRateLimit?.rpm ?? 60,
    tpm: spec.freeRateLimit?.tpm ?? 0,
  });

  let resolvedDefaultModel = options.defaultModel;
  let modelsFetched = false;

  async function resolveModel(opts?: CompleteOptions): Promise<string> {
    if (opts?.model) {
      return opts.model;
    }
    // Auto-detect when explicitly requested (local-first) or for the generic
    // "gpt-4o" placeholder used by unconfigured custom OpenAI-compatible servers.
    if ((autoDetect || resolvedDefaultModel === "gpt-4o") && !modelsFetched) {
      modelsFetched = true;
      try {
        const url = `${baseUrl}/models`;
        const headers: Record<string, string> = { "Content-Type": "application/json" };
        if (options.apiKey) {
          headers.Authorization = `Bearer ${options.apiKey}`;
        }
        const res = await doFetch(url, { headers, signal: AbortSignal.timeout(3000) });
        if (res.ok) {
          const json = (await res.json()) as any;
          const list: any[] = Array.isArray(json?.data) ? json.data : [];
          const ids = list.map((m) => m?.id).filter((x): x is string => typeof x === "string");
          if (ids.length > 0) {
            // Keep the configured model only if the server actually serves it;
            // otherwise fall back to the first available model.
            resolvedDefaultModel = ids.includes(resolvedDefaultModel)
              ? resolvedDefaultModel
              : ids[0];
          }
        }
      } catch {
        // Server unreachable or no /models endpoint — keep the configured default.
      }
    }
    return resolvedDefaultModel;
  }

  function buildBody(
    resolvedModel: string,
    messages: ChatMessage[],
    opts?: CompleteOptions,
    stream = false
  ): Record<string, unknown> {
    const model = resolvedModel;
    const modelSpec = getModelSpec(model);

    let maxTokens = opts?.maxTokens;
    let temperature = opts?.temperature;
    let thinkingVal: string | number | undefined = undefined;

    try {
      const config = loadAgencyConfig();
      const profile = config.providers[options.id] ?? {};
      thinkingVal = profile.thinking;
    } catch {
      // safe fallback
    }

    const lastPrompt = messages[messages.length - 1]?.content ?? "";
    const intent = inferTaskIntent(lastPrompt);
    const optimization = optimizeForTask(intent, modelSpec, thinkingVal);

    if (opts?.onOptimization) {
      opts.onOptimization({
        budget: optimization.thinkingBudget ?? 0,
        intent,
        type: modelSpec.thinkingType,
      });
    }

    if (maxTokens === undefined) {
      maxTokens = optimization.maxOutputTokens;
    } else {
      maxTokens = Math.min(maxTokens, optimization.maxOutputTokens);
    }

    if (temperature === undefined && optimization.temperature !== null) {
      temperature = optimization.temperature;
    }

    const body: Record<string, any> = {
      model,
      messages,
    };
    if (stream) {
      body.stream = true;
      body.stream_options = { include_usage: true };
    }
    if (maxTokens !== undefined) body.max_tokens = maxTokens;
    if (temperature !== undefined) body.temperature = temperature;

    if (modelSpec.thinkingType === "effort") {
      const effort = typeof thinkingVal === "string" && ["low", "medium", "high"].includes(thinkingVal)
        ? thinkingVal
        : "medium";
      body.reasoning_effort = effort;
    } else if (modelSpec.thinkingType === "budget" && optimization.thinkingBudget !== null) {
      const budgetNum = optimization.thinkingBudget;
      if (budgetNum > 0) {
        body.max_completion_tokens = Math.max(body.max_tokens ?? 2048, budgetNum * 2);
      }
    }

    return body;
  }

  function authHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...options.extraHeaders,
    };
    if (options.apiKey) {
      headers.Authorization = `Bearer ${options.apiKey}`;
    }
    return headers;
  }

  return {
    id: options.id,
    async complete(
      messages: ChatMessage[],
      opts?: CompleteOptions
    ): Promise<string> {
      const resolvedModel = await resolveModel(opts);
      return limiter.retryWithBackoff(async () => {
        const { signal, cleanup, timedOut } = createTimeoutSignal(opts?.signal, timeoutMs);
        let res: Response;
        try {
          res = await doFetch(`${baseUrl}/chat/completions`, {
            method: "POST",
            headers: authHeaders(),
            body: JSON.stringify(buildBody(resolvedModel, messages, opts, false)),
            signal,
          });
        } catch (err) {
          if (timedOut()) {
            throw new Error(`${options.id} request timed out after ${timeoutMs}ms at ${baseUrl}`);
          }
          throw enrichConnectionError(err, options.id, baseUrl);
        } finally {
          cleanup();
        }

        if (!res.ok) {
          throw await parseLlmError(options.id, res);
        }

        const data = (await res.json()) as {
          choices?: Array<{
            message?: { content?: string; reasoning_content?: string };
            finish_reason?: string;
          }>;
          usage?: {
            prompt_tokens: number;
            completion_tokens: number;
            reasoning_tokens?: number;
            completion_tokens_details?: {
              reasoning_tokens?: number;
            };
          };
        };
        let content = data.choices?.[0]?.message?.content;
        if (typeof content !== "string") {
          throw new Error(`${options.id} API returned no content`);
        }

        let thought = "";
        const reasoningContent = data.choices?.[0]?.message?.reasoning_content;
        if (typeof reasoningContent === "string" && reasoningContent) {
          thought = reasoningContent;
          if (opts?.onThought) {
            opts.onThought(reasoningContent);
          }
        }

        // Fallback regex matching <think>...</think>
        if (content.includes("<think>")) {
          const thinkRegex = /<think>([\s\S]*?)(?:<\/think>|$)/g;
          let match;
          let cleanContent = content;
          while ((match = thinkRegex.exec(content)) !== null) {
            const extracted = match[1];
            if (extracted) {
              thought += (thought ? "\n" : "") + extracted;
              if (opts?.onThought) {
                opts.onThought(extracted);
              }
            }
          }
          cleanContent = content.replace(/<think>[\s\S]*?(?:<\/think>|$)/g, "").trim();
          content = cleanContent;
        }

        if (data.choices?.[0]?.finish_reason && opts?.onFinishReason) {
          opts.onFinishReason(data.choices[0].finish_reason);
        }

        if (data.usage && opts?.onUsage) {
          opts.onUsage({
            promptTokens: data.usage.prompt_tokens,
            completionTokens: data.usage.completion_tokens,
            reasoningTokens:
              data.usage.completion_tokens_details?.reasoning_tokens ??
              data.usage.reasoning_tokens,
          });
        }

        limiter.recordUsage(Math.ceil(content.length / 4));
        return content;
      });
    },

    async streamComplete(
      messages: ChatMessage[],
      opts: StreamCompleteOptions
    ): Promise<string> {
      const resolvedModel = await resolveModel(opts);
      return limiter.retryWithBackoff(async () => {
        // Idle-timeout: abort the stream if no token arrives within idleTimeoutMs.
        // This is reset on every chunk, so long valid responses are never cut off
        // — only genuinely stalled connections are aborted.
        const idleController = new AbortController();
        let idleFired = false;
        let idleTimer: ReturnType<typeof setTimeout> | undefined;
        const resetIdle = () => {
          if (idleTimeoutMs <= 0) return;
          if (idleTimer) clearTimeout(idleTimer);
          idleTimer = setTimeout(() => {
            idleFired = true;
            idleController.abort(new Error(`stream idle for ${idleTimeoutMs}ms`));
          }, idleTimeoutMs);
          if (typeof (idleTimer as any)?.unref === "function") (idleTimer as any).unref();
        };
        const clearIdle = () => {
          if (idleTimer) clearTimeout(idleTimer);
        };

        const signals: AbortSignal[] = [idleController.signal];
        if (opts.signal) signals.push(opts.signal);
        const signal = signals.length > 1 ? AbortSignal.any(signals) : signals[0];

        let res: Response;
        resetIdle();
        try {
          res = await doFetch(`${baseUrl}/chat/completions`, {
            method: "POST",
            headers: authHeaders(),
            body: JSON.stringify(buildBody(resolvedModel, messages, opts, true)),
            signal,
          });
        } catch (err) {
          clearIdle();
          if (idleFired) {
            throw new Error(`${options.id} stream stalled (no response within ${idleTimeoutMs}ms) at ${baseUrl}`);
          }
          throw enrichConnectionError(err, options.id, baseUrl);
        }

        if (!res.ok) {
          clearIdle();
          throw await parseLlmError(options.id, res);
        }

        if (!res.body) {
          clearIdle();
          const full = await this.complete(messages, opts);
          opts.onDelta(full);
          return full;
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let full = "";
        let fullThought = "";

        const thinkFilter = new StreamingThinkFilter(
          (text) => {
            full += text;
            opts.onDelta(text);
          },
          (thought) => {
            fullThought += thought;
            opts.onThought?.(thought);
          }
        );

        function processLines(lines: string[]) {
          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith("data:")) continue;
            const payload = trimmed.slice(5).trim();
            if (!payload || payload === "[DONE]") continue;
            try {
              const json = JSON.parse(payload) as {
                choices?: Array<{
                  delta?: {
                    content?: string;
                    reasoning_content?: string;
                  };
                  finish_reason?: string;
                }>;
                usage?: {
                  prompt_tokens: number;
                  completion_tokens: number;
                  reasoning_tokens?: number;
                  completion_tokens_details?: {
                    reasoning_tokens?: number;
                  };
                };
              };

              if (json.usage && opts.onUsage) {
                opts.onUsage({
                  promptTokens: json.usage.prompt_tokens,
                  completionTokens: json.usage.completion_tokens,
                  reasoningTokens:
                    json.usage.completion_tokens_details?.reasoning_tokens ??
                    json.usage.reasoning_tokens,
                });
              }

              if (json.choices?.[0]?.finish_reason && opts.onFinishReason) {
                opts.onFinishReason(json.choices[0].finish_reason);
              }

              const reasoning = json.choices?.[0]?.delta?.reasoning_content;
              if (typeof reasoning === "string" && reasoning.length > 0) {
                fullThought += reasoning;
                opts.onThought?.(reasoning);
              }

              const contentPiece = json.choices?.[0]?.delta?.content;
              if (typeof contentPiece === "string" && contentPiece.length > 0) {
                thinkFilter.feed(contentPiece);
              }
            } catch {
              // ignore malformed SSE frames
            }
          }
        }

        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            resetIdle();
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop() ?? "";
            processLines(lines);
          }
        } catch (err) {
          if (idleFired) {
            throw new Error(`${options.id} stream stalled (no token for ${idleTimeoutMs}ms) at ${baseUrl}`);
          }
          throw enrichConnectionError(err, options.id, baseUrl);
        } finally {
          clearIdle();
          try {
            reader.releaseLock();
          } catch {
            // reader already released
          }
        }

        if (buffer.trim()) {
          const lines = `${buffer}\n\n`.split("\n");
          processLines(lines);
        }

        thinkFilter.flush();

        if (!full && !fullThought) {
          throw new Error(`${options.id} stream returned no content`);
        }

        limiter.recordUsage(Math.ceil(full.length / 4));
        return full;
      });
    },
  };
}

class StreamingThinkFilter {
  private buffer = "";
  private inThink = false;
  private onText: (text: string) => void;
  private onThought: (thought: string) => void;

  constructor(onText: (text: string) => void, onThought: (thought: string) => void) {
    this.onText = onText;
    this.onThought = onThought;
  }

  public feed(chunk: string) {
    this.buffer += chunk;
    this.process();
  }

  private process() {
    while (true) {
      if (!this.inThink) {
        const thinkIndex = this.buffer.indexOf("<think>");
        if (thinkIndex !== -1) {
          if (thinkIndex > 0) {
            this.onText(this.buffer.slice(0, thinkIndex));
          }
          this.inThink = true;
          this.buffer = this.buffer.slice(thinkIndex + 7);
          continue;
        }

        const possibleStart = "<think>";
        let partialMatch = false;
        for (let len = possibleStart.length - 1; len > 0; len--) {
          const prefix = possibleStart.slice(0, len);
          if (this.buffer.endsWith(prefix)) {
            const emitLen = this.buffer.length - len;
            if (emitLen > 0) {
              this.onText(this.buffer.slice(0, emitLen));
              this.buffer = this.buffer.slice(emitLen);
            }
            partialMatch = true;
            break;
          }
        }
        if (partialMatch) {
          break;
        }

        if (this.buffer.length > 0) {
          this.onText(this.buffer);
          this.buffer = "";
        }
        break;
      } else {
        const endIndex = this.buffer.indexOf("</think>");
        if (endIndex !== -1) {
          if (endIndex > 0) {
            this.onThought(this.buffer.slice(0, endIndex));
          }
          this.inThink = false;
          this.buffer = this.buffer.slice(endIndex + 8);
          continue;
        }

        const possibleEnd = "</think>";
        let partialMatch = false;
        for (let len = possibleEnd.length - 1; len > 0; len--) {
          const prefix = possibleEnd.slice(0, len);
          if (this.buffer.endsWith(prefix)) {
            const emitLen = this.buffer.length - len;
            if (emitLen > 0) {
              this.onThought(this.buffer.slice(0, emitLen));
              this.buffer = this.buffer.slice(emitLen);
            }
            partialMatch = true;
            break;
          }
        }
        if (partialMatch) {
          break;
        }

        if (this.buffer.length > 0) {
          this.onThought(this.buffer);
          this.buffer = "";
        }
        break;
      }
    }
  }

  public flush() {
    if (this.buffer.length > 0) {
      if (this.inThink) {
        this.onThought(this.buffer);
      } else {
        this.onText(this.buffer);
      }
      this.buffer = "";
    }
  }
}
