import { describe, expect, it, vi, type Mock } from "vitest";
import { createAnthropicProvider } from "../anthropic.js";
import { createGoogleProvider } from "../google.js";
import { createProvider, getProvider } from "../registry.js";
import type { AgencyConfig } from "../types.js";

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

const baseConfig: AgencyConfig = {
  defaultProvider: "openai",
  providers: {
    openai: { apiKey: "oa-key", model: "gpt-4o-mini" },
    anthropic: { apiKey: "an-key" },
    google: { apiKey: "go-key" },
    openrouter: { apiKey: "or-key" },
    nvidia: { apiKey: "nv-key" },
    local: { baseUrl: "http://localhost:11434/v1" },
  },
};

describe("registry", () => {
  it("createProvider builds each provider id", () => {
    const ids = [
      "openai",
      "anthropic",
      "google",
      "openrouter",
      "nvidia",
      "local",
    ] as const;
    for (const id of ids) {
      const provider = createProvider(
        id,
        baseConfig,
        mockFetch({ json: {} }) as unknown as typeof fetch
      );
      expect(provider.id).toBe(id);
    }
  });

  it("getProvider uses defaultProvider when override is omitted", () => {
    const fetchImpl = mockFetch({
      json: { choices: [{ message: { content: "default" } }] },
    });
    const provider = getProvider(
      baseConfig,
      undefined,
      fetchImpl as unknown as typeof fetch
    );
    expect(provider.id).toBe("openai");
  });

  it("getProvider honors override id", () => {
    const fetchImpl = mockFetch({
      json: { choices: [{ message: { content: "routed" } }] },
    });
    const provider = getProvider(
      baseConfig,
      "openrouter",
      fetchImpl as unknown as typeof fetch
    );
    expect(provider.id).toBe("openrouter");
  });

  it("resolves env placeholders in api keys", async () => {
    process.env.AGENCY_TEST_OPENAI = "resolved-key";
    const fetchImpl = mockFetch({
      json: { choices: [{ message: { content: "ok" } }] },
    });
    const config: AgencyConfig = {
      defaultProvider: "openai",
      providers: { openai: { apiKey: "${AGENCY_TEST_OPENAI}" } },
    };
    const provider = createProvider(
      "openai",
      config,
      fetchImpl as unknown as typeof fetch
    );
    await provider.complete([{ role: "user", content: "hi" }]);
    const headers = fetchImpl.mock.calls[0][1]?.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer resolved-key");
    delete process.env.AGENCY_TEST_OPENAI;
  });

  it("instantiates custom provider as OpenAI-compatible and checks baseUrl", () => {
    const customConfig: AgencyConfig = {
      defaultProvider: "deepseek",
      providers: {
        deepseek: { baseUrl: "https://api.deepseek.com/v1", apiKey: "ds-key" },
      },
    };
    
    const provider = createProvider(
      "deepseek",
      customConfig,
      mockFetch({ json: {} }) as unknown as typeof fetch
    );
    expect(provider.id).toBe("deepseek");

    const invalidConfig: AgencyConfig = {
      defaultProvider: "invalid-custom",
      providers: {
        "invalid-custom": { apiKey: "key" },
      },
    };
    expect(() =>
      createProvider(
        "invalid-custom",
        invalidConfig,
        mockFetch({ json: {} }) as unknown as typeof fetch
      )
    ).toThrowError(/must configure a "baseUrl"/);
  });

  it("lazy loads first model from custom provider /models endpoint", async () => {
    const customConfig: AgencyConfig = {
      defaultProvider: "custom-lazy",
      providers: {
        "custom-lazy": { baseUrl: "https://api.custom.com/v1" },
      },
    };

    const fetchImpl = vi.fn();
    // First call: models list query
    fetchImpl.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        data: [{ id: "model-lazy-loaded-123" }],
      }),
    });
    // Second call: completions request
    fetchImpl.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { content: "lazy-reply" } }],
      }),
    });

    const provider = createProvider(
      "custom-lazy",
      customConfig,
      fetchImpl as unknown as typeof fetch
    );

    const reply = await provider.complete([{ role: "user", content: "hello" }]);
    expect(reply).toBe("lazy-reply");

    expect(fetchImpl.mock.calls.length).toBe(2);
    expect(fetchImpl.mock.calls[0][0]).toBe("https://api.custom.com/v1/models");
    
    const chatBody = JSON.parse(fetchImpl.mock.calls[1][1].body);
    expect(chatBody.model).toBe("model-lazy-loaded-123");
  });
});

describe("createAnthropicProvider", () => {
  it("calls Anthropic messages API with system split out", async () => {
    const fetchImpl = mockFetch({
      json: { content: [{ type: "text", text: "Anthropic reply" }] },
    });
    const provider = createAnthropicProvider(
      { apiKey: "sk-ant" },
      fetchImpl as unknown as typeof fetch
    );
    const result = await provider.complete([
      { role: "system", content: "Be concise." },
      { role: "user", content: "Hello" },
    ]);
    expect(result).toBe("Anthropic reply");
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    const headers = init.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe("sk-ant");
    expect(headers["anthropic-version"]).toBe("2023-06-01");
    const body = JSON.parse(String(init.body));
    expect(body.system).toBe("Be concise.");
    expect(body.messages).toEqual([{ role: "user", content: "Hello" }]);
  });
});

describe("createGoogleProvider", () => {
  it("uses Gemini generateContent when baseUrl is not set", async () => {
    const fetchImpl = mockFetch({
      json: {
        candidates: [{ content: { parts: [{ text: "Gemini reply" }] } }],
      },
    });
    const provider = createGoogleProvider(
      { apiKey: "gem-key" },
      fetchImpl as unknown as typeof fetch
    );
    const result = await provider.complete([
      { role: "system", content: "System prompt" },
      { role: "user", content: "Question" },
    ]);
    expect(result).toBe("Gemini reply");
    const [url] = fetchImpl.mock.calls[0] as [string];
    expect(url).toContain("generativelanguage.googleapis.com");
    expect(url).toContain("key=gem-key");
  });
});
