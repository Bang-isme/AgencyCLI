import { loadAgencyConfig, resolveApiKey } from "./config.js";
import type { AgencyConfig, ProviderId } from "./types.js";
import { getModelSpec } from "./thinking-spec.js";


export interface ProbeResult {
  model: string;
  provider: string;
  success: boolean;
  contextWindow: number;
  maxOutputTokens: number;
  thinkingType: "budget" | "effort" | "none";
  supportsTools: boolean;
  traceLogs: string[];
  rawDetails: {
    effortSupported: boolean;
    budgetSupported: boolean;
    nativeReasoningTokens: boolean;
    thinkTagsReturned: boolean;
    maxTokensValidationMessage?: string;
  };
  baselineContextWindow: number;
  baselineMaxOutput: number;
  baselineThinking: "budget" | "effort" | "none";
}

export async function probeModel(
  providerId: ProviderId,
  model: string,
  config?: AgencyConfig,
  fetchImpl: typeof fetch = globalThis.fetch
): Promise<ProbeResult> {
  const traceLogs: string[] = [];
  const activeConfig = config ?? loadAgencyConfig();
  const profile = activeConfig.providers[providerId] ?? {};
  const apiKey = resolveApiKey(profile);

  traceLogs.push(`[Probe] Bắt đầu chẩn đoán cho model: "${model}" (Provider: ${providerId.toUpperCase()})`);

  if (!apiKey && providerId !== "local") {
    traceLogs.push(`[Error] Thiếu API Key cho provider "${providerId}". Không thể chạy chẩn đoán trực tiếp.`);
    return createErrorResult(providerId, model, traceLogs, "Thiếu API Key");
  }

  // Resolve base URL
  let baseUrl = profile.baseUrl || "";
  if (!baseUrl) {
    if (providerId === "openai") baseUrl = "https://api.openai.com/v1";
    else if (providerId === "anthropic") baseUrl = "https://api.anthropic.com/v1";
    else if (providerId === "google") baseUrl = "https://generativelanguage.googleapis.com/v1beta";
    else if (providerId === "openrouter") baseUrl = "https://openrouter.ai/api/v1";
    else if (providerId === "nvidia") baseUrl = "https://integrate.api.nvidia.com/v1";
    else if (providerId === "local") baseUrl = "http://localhost:11434/v1";
  }
  baseUrl = baseUrl.replace(/\/$/, "");

  const baselineSpec = getModelSpec(model);
  let contextWindow = baselineSpec.contextWindow;
  let maxOutputTokens = baselineSpec.maxOutputTokens;
  let effortSupported = false;
  let budgetSupported = false;
  let nativeReasoningTokens = false;
  let thinkTagsReturned = false;
  let supportsTools = false;
  let maxTokensValidationMessage = "";

  // 1. API Metadata Query
  if (providerId === "openrouter" || providerId === "nvidia" || providerId === "openai") {
    traceLogs.push(`[Probe] Bước 1: Truy vấn danh sách models để lấy metadata...`);
    try {
      const modelsUrl = providerId === "openrouter" ? "https://openrouter.ai/api/v1/models" : `${baseUrl}/models`;
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;

      const res = await fetchImpl(modelsUrl, { headers, signal: AbortSignal.timeout(6000) });
      if (res.ok) {
        const json = await res.json() as any;
        const match = json.data?.find((m: any) => m.id === model || m.id.endsWith(model) || model.endsWith(m.id));
        if (match) {
          const cw = match.context_length ?? match.context_window ?? match.max_position_embeddings;
          if (typeof cw === "number") {
            contextWindow = cw;
            traceLogs.push(`  → Tìm thấy từ Metadata: contextWindow = ${cw.toLocaleString()} tokens.`);
          }
          const routerMax = match.top_provider?.max_completion_tokens ?? match.max_completion_tokens;
          if (typeof routerMax === "number") {
            maxOutputTokens = routerMax;
            traceLogs.push(`  → Tìm thấy từ Metadata: maxOutputTokens = ${routerMax.toLocaleString()} tokens.`);
          }
        } else {
          traceLogs.push(`  → Model không có trong danh sách metadata trả về từ endpoint. Sẽ tự suy luận.`);
        }
      } else {
        traceLogs.push(`  → Endpoint trả về status ${res.status}. Bỏ qua metadata check.`);
      }
    } catch (err: any) {
      traceLogs.push(`  → Thất bại khi lấy metadata: ${err.message}`);
    }
  }

  // Helper to send complete raw completions requests
  const sendRequest = async (body: Record<string, any>): Promise<{ ok: boolean; status: number; text: string; data?: any }> => {
    try {
      let url = "";
      const headers: Record<string, string> = { "Content-Type": "application/json" };

      if (providerId === "anthropic") {
        url = `${baseUrl}/messages`;
        headers["x-api-key"] = apiKey || "";
        headers["anthropic-version"] = "2023-06-01";
      } else if (providerId === "google" && !profile.baseUrl) {
        url = `${baseUrl}/models/${model}:generateContent?key=${encodeURIComponent(apiKey || "")}`;
      } else {
        url = `${baseUrl}/chat/completions`;
        if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
      }

      const res = await fetchImpl(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(8000),
      });

      const text = await res.text();
      let data: any = null;
      try {
        data = JSON.parse(text);
      } catch {}
      return { ok: res.ok, status: res.status, text, data };
    } catch (err: any) {
      return { ok: false, status: 0, text: err.message };
    }
  };

  // Helper to construct payload
  const makePayload = (params: {
    maxTokens?: number;
    reasoningEffort?: string;
    maxCompletionTokens?: number;
    enableThinkingBudget?: number;
    tools?: boolean;
    simplePrompt?: string;
  }) => {
    const prompt = params.simplePrompt ?? "Hi";
    if (providerId === "anthropic") {
      const payload: Record<string, any> = {
        model,
        messages: [{ role: "user", content: prompt }],
        max_tokens: params.maxTokens ?? 10,
      };
      if (params.enableThinkingBudget) {
        payload.thinking = { type: "enabled", budget_tokens: params.enableThinkingBudget };
        payload.max_tokens = Math.max(payload.max_tokens, params.enableThinkingBudget + 1024);
      }
      return payload;
    }

    if (providerId === "google" && !profile.baseUrl) {
      const generationConfig: Record<string, any> = {
        maxOutputTokens: params.maxTokens ?? 10,
      };
      if (params.enableThinkingBudget) {
        generationConfig.thinkingConfig = { thinkingBudget: params.enableThinkingBudget };
      }
      return {
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig,
      };
    }

    const payload: Record<string, any> = {
      model,
      messages: [{ role: "user", content: prompt }],
    };
    if (params.maxTokens !== undefined) payload.max_tokens = params.maxTokens;
    if (params.reasoningEffort !== undefined) payload.reasoning_effort = params.reasoningEffort;
    if (params.maxCompletionTokens !== undefined) payload.max_completion_tokens = params.maxCompletionTokens;

    if (params.tools) {
      payload.tools = [
        {
          type: "function",
          function: {
            name: "test_tool",
            description: "A tool for testing",
            parameters: { type: "object", properties: {} },
          },
        },
      ];
    }
    return payload;
  };

  // 2. Probe Reasoning (Effort and Budget)
  if (providerId !== "anthropic" && !(providerId === "google" && !profile.baseUrl)) {
    traceLogs.push(`[Probe] Bước 2: Thử nghiệm tham số 'reasoning_effort' (OpenAI o-series)...`);
    const resEffort = await sendRequest(makePayload({ reasoningEffort: "low", maxCompletionTokens: 5 }));
    if (resEffort.ok) {
      effortSupported = true;
      traceLogs.push(`  → Thành công: Model hỗ trợ 'reasoning_effort'.`);
    } else {
      traceLogs.push(`  → Không hỗ trợ 'reasoning_effort' (Lỗi ${resEffort.status}: ${resEffort.text.slice(0, 100)}).`);
    }

    if (!effortSupported) {
      traceLogs.push(`[Probe] Bước 2.5: Thử nghiệm tham số 'max_completion_tokens' (DeepSeek/Gemini budget)...`);
      const resBudget = await sendRequest(makePayload({ maxCompletionTokens: 5 }));
      if (resBudget.ok) {
        budgetSupported = true;
        traceLogs.push(`  → Thành công: Model hỗ trợ 'max_completion_tokens'.`);
      } else {
        traceLogs.push(`  → Không hỗ trợ 'max_completion_tokens' (Lỗi ${resBudget.status}).`);
      }
    }
  } else if (providerId === "anthropic") {
    traceLogs.push(`[Probe] Bước 2 (Anthropic): Thử nghiệm chế độ 'thinking' với budget_tokens...`);
    const resAnthropic = await sendRequest(makePayload({ enableThinkingBudget: 1024, maxTokens: 10 }));
    if (resAnthropic.ok) {
      budgetSupported = true;
      traceLogs.push(`  → Thành công: Anthropic Claude hỗ trợ suy nghĩ.`);
    } else {
      traceLogs.push(`  → Không hỗ trợ thinking budget (Lỗi ${resAnthropic.status}: ${resAnthropic.text.slice(0, 100)}).`);
    }
  } else if (providerId === "google" && !profile.baseUrl) {
    traceLogs.push(`[Probe] Bước 2 (Google Gemini REST): Thử nghiệm 'thinkingConfig' với thinkingBudget...`);
    const resGemini = await sendRequest(makePayload({ enableThinkingBudget: 1024, maxTokens: 10 }));
    if (resGemini.ok) {
      budgetSupported = true;
      traceLogs.push(`  → Thành công: Gemini hỗ trợ thinkingConfig.`);
    } else {
      traceLogs.push(`  → Không hỗ trợ thinkingConfig (Lỗi ${resGemini.status}: ${resGemini.text.slice(0, 100)}).`);
    }
  }

  // 3. Probe Reasoning Content Response (Trích xuất suy nghĩ thực tế)
  traceLogs.push(`[Probe] Bước 3: Gửi prompt suy luận để kiểm tra nội dung reasoning thực tế...`);
  const testPayload = makePayload({
    simplePrompt: "Hãy suy nghĩ thật kỹ từng bước và viết ra 2 từ: 'Xin chào'.",
    maxTokens: 50,
    maxCompletionTokens: budgetSupported ? 25 : undefined,
    reasoningEffort: effortSupported ? "low" : undefined,
    enableThinkingBudget: (providerId === "anthropic" || (providerId === "google" && !profile.baseUrl)) && budgetSupported ? 1024 : undefined
  });
  const resContent = await sendRequest(testPayload);
  if (resContent.ok && resContent.data) {
    // Check DeepSeek/OpenAI style native reasoning content
    const choice0 = resContent.data.choices?.[0];
    const hasNativeReasoning = !!(choice0?.message?.reasoning_content || choice0?.message?.reasoning);
    // Check Anthropic block
    const hasAnthropicThinking = !!resContent.data.content?.some((c: any) => c.type === "thinking");
    // Check Google block
    const hasGoogleThought = !!resContent.data.candidates?.[0]?.content?.parts?.some((p: any) => p.thought);

    if (hasNativeReasoning || hasAnthropicThinking || hasGoogleThought) {
      nativeReasoningTokens = true;
      traceLogs.push(`  → Phát hiện Native Reasoning tokens trả về trong JSON structure.`);
    }

    // Check think tags in plain text
    const textContent = choice0?.message?.content || resContent.data.content?.find((c: any) => c.type === "text")?.text || "";
    if (textContent.includes("<think>")) {
      thinkTagsReturned = true;
      traceLogs.push(`  → Phát hiện tag '<think>' xuất hiện trong phản hồi văn bản.`);
    }
  } else {
    traceLogs.push(`  → Thử nghiệm phản hồi suy luận thất bại hoặc rỗng.`);
  }

  // 4. Force Validation limit to find max output tokens
  traceLogs.push(`[Probe] Bước 4: Thử nghiệm gửi max_tokens = 10,000,000 để ép lỗi validation...`);
  const overflowPayload = makePayload({ maxTokens: 10_000_000, maxCompletionTokens: budgetSupported ? 10_000_000 : undefined });
  const resOverflow = await sendRequest(overflowPayload);
  if (!resOverflow.ok) {
    maxTokensValidationMessage = resOverflow.text;
    traceLogs.push(`  → API từ chối thành công. Lỗi nhận được: "${resOverflow.text.slice(0, 120)}..."`);
    // Try to extract exact number from error text using regex: find 4 to 8 digits, filter out input payload (10_000_000)
    const allNumbers = [...resOverflow.text.matchAll(/\b(\d{4,8})\b/g)]
      .map(m => parseInt(m[1], 10))
      .filter(n => n >= 1024 && n <= 12000000 && n !== 10000000);
    if (allNumbers.length > 0) {
      const extracted = Math.min(...allNumbers);
      maxOutputTokens = extracted;
      traceLogs.push(`  ✓ Phát hiện chính xác giới hạn max output tokens: ${extracted.toLocaleString()} tokens.`);
    }
  } else {
    traceLogs.push(`  → API chấp nhận max_tokens cực lớn (không báo lỗi). Giữ nguyên dự đoán.`);
  }

  // 5. Probe Tool Calling Support
  traceLogs.push(`[Probe] Bước 5: Gửi định nghĩa Tool để xác thực khả năng hỗ trợ gọi hàm...`);
  const toolPayload = makePayload({ tools: true, maxTokens: 10 });
  const resTools = await sendRequest(toolPayload);
  if (resTools.ok) {
    supportsTools = true;
    traceLogs.push(`  → Thành công: Model hỗ trợ tham số 'tools' mà không báo lỗi.`);
  } else {
    traceLogs.push(`  → Không hỗ trợ tools (Lỗi ${resTools.status}: ${resTools.text.slice(0, 100)}).`);
  }

  // Deduce thinking type
  let thinkingType: "budget" | "effort" | "none" = "none";
  if (effortSupported) thinkingType = "effort";
  else if (budgetSupported || nativeReasoningTokens || thinkTagsReturned) thinkingType = "budget";

  traceLogs.push(`[Probe] Hoàn tất chẩn đoán.`);

  return {
    model,
    provider: providerId,
    success: true,
    contextWindow,
    maxOutputTokens,
    thinkingType,
    supportsTools,
    traceLogs,
    rawDetails: {
      effortSupported,
      budgetSupported,
      nativeReasoningTokens,
      thinkTagsReturned,
      maxTokensValidationMessage
    },
    baselineContextWindow: baselineSpec.contextWindow,
    baselineMaxOutput: baselineSpec.maxOutputTokens,
    baselineThinking: baselineSpec.thinkingType
  };
}

function createErrorResult(provider: string, model: string, logs: string[], detail: string): ProbeResult {
  const fallback = getModelSpec(model);
  return {
    model,
    provider,
    success: false,
    contextWindow: fallback.contextWindow,
    maxOutputTokens: fallback.maxOutputTokens,
    thinkingType: fallback.thinkingType,
    supportsTools: false,
    traceLogs: logs,
    rawDetails: {
      effortSupported: false,
      budgetSupported: false,
      nativeReasoningTokens: false,
      thinkTagsReturned: false,
      maxTokensValidationMessage: detail
    },
    baselineContextWindow: fallback.contextWindow,
    baselineMaxOutput: fallback.maxOutputTokens,
    baselineThinking: fallback.thinkingType
  };
}
