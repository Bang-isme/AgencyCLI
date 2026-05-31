import { describe, expect, it, vi, type Mock } from "vitest";
import { createOpenAiCompatibleProvider } from "../adapters/openai-compatible.js";

vi.mock("../config.js", () => ({
  loadAgencyConfig: vi.fn(() => ({
    defaultProvider: "openai",
    providers: {
      openai: {
        thinking: "high",
      },
    },
    modelOverrides: {
      "custom-llm": {
        contextWindow: 500000,
        maxOutputTokens: 32000,
        thinkingType: "budget",
      },
    },
  })),
}));

function mockFetch(response: {
  ok?: boolean;
  status?: number;
  json?: unknown;
  text?: string;
}): Mock {
  return vi.fn().mockResolvedValue({
    ok: response.ok ?? true,
    status: response.status ?? 200,
    text: async () => response.text ?? JSON.stringify(response.json),
    json: async () => response.json,
  });
}

describe("createOpenAiCompatibleProvider", () => {
  it("posts to /chat/completions and returns assistant content", async () => {
    const fetchImpl = mockFetch({
      json: {
        choices: [{ message: { content: "Hello from model" } }],
      },
    });

    const provider = createOpenAiCompatibleProvider({
      id: "openai",
      apiKey: "test-key",
      baseUrl: "https://api.example.com/v1",
      defaultModel: "gpt-test",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const result = await provider.complete([
      { role: "system", content: "You are helpful." },
      { role: "user", content: "Hi" },
    ]);

    expect(result).toBe("Hello from model");
    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.example.com/v1/chat/completions");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Authorization).toBe(
      "Bearer test-key"
    );
    const body = JSON.parse(String(init.body));
    expect(body.model).toBe("gpt-test");
    expect(body.messages).toHaveLength(2);
  });

  it("throws on non-ok responses", async () => {
    const fetchImpl = mockFetch({
      ok: false,
      status: 401,
      text: "unauthorized",
    });

    const provider = createOpenAiCompatibleProvider({
      id: "openrouter",
      baseUrl: "https://openrouter.ai/api/v1",
      defaultModel: "test",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await expect(
      provider.complete([{ role: "user", content: "x" }])
    ).rejects.toThrow("openrouter API error 401: unauthorized");
  });

  it("honors complete options overrides", async () => {
    const fetchImpl = mockFetch({
      json: { choices: [{ message: { content: "ok" } }] },
    });

    const provider = createOpenAiCompatibleProvider({
      id: "nvidia",
      baseUrl: "https://integrate.api.nvidia.com/v1",
      defaultModel: "default-model",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await provider.complete([{ role: "user", content: "x" }], {
      model: "override-model",
      maxTokens: 256,
      temperature: 0.2,
    });

    const body = JSON.parse(String(fetchImpl.mock.calls[0][1]?.body));
    expect(body.model).toBe("override-model");
    expect(body.max_tokens).toBe(256);
    expect(body.temperature).toBe(0.2);
  });

  it("handles effort-based models mapping reasoning_effort", async () => {
    const fetchImpl = mockFetch({
      json: { choices: [{ message: { content: "ok" } }] },
    });

    const provider = createOpenAiCompatibleProvider({
      id: "openai",
      baseUrl: "https://api.openai.com/v1",
      defaultModel: "o3-mini",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await provider.complete([{ role: "user", content: "x" }]);

    const body = JSON.parse(String(fetchImpl.mock.calls[0][1]?.body));
    expect(body.reasoning_effort).toBe("high"); // From mock loadAgencyConfig thinking: high
  });

  it("handles budget-based models mapping max_completion_tokens", async () => {
    const fetchImpl = mockFetch({
      json: { choices: [{ message: { content: "ok" } }] },
    });

    const provider = createOpenAiCompatibleProvider({
      id: "openai",
      baseUrl: "https://api.openai.com/v1",
      defaultModel: "deepseek-r1",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await provider.complete([{ role: "user", content: "x" }]);

    const body = JSON.parse(String(fetchImpl.mock.calls[0][1]?.body));
    expect(body.max_completion_tokens).toBeDefined();
    expect(body.max_completion_tokens).toBeGreaterThan(0);
  });

  it("honors config modelOverrides propagation", async () => {
    const fetchImpl = mockFetch({
      json: { choices: [{ message: { content: "ok" } }] },
    });

    const provider = createOpenAiCompatibleProvider({
      id: "openai",
      baseUrl: "https://api.openai.com/v1",
      defaultModel: "custom-llm", // matches overrides
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await provider.complete([{ role: "user", content: "x" }]);

    const body = JSON.parse(String(fetchImpl.mock.calls[0][1]?.body));
    expect(body.max_completion_tokens).toBeDefined();
  });
});
