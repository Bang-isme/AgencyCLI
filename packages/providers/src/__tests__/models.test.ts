import { describe, expect, it, vi, type Mock } from "vitest";
import { listProviderModels } from "../models.js";

function mockFetch(response: {
  ok?: boolean;
  status?: number;
  json?: unknown;
}): Mock {
  return vi.fn().mockResolvedValue({
    ok: response.ok ?? true,
    status: response.status ?? 200,
    json: async () => response.json,
  });
}

describe("providers/models", () => {
  it("uses custom local Ollama baseUrl and resolves tags endpoint dynamically", async () => {
    const fetchImpl = mockFetch({
      json: {
        models: [
          { name: "llama3.2:latest" },
          { name: "qwen2.5-coder:7b" }
        ]
      }
    });

    const models = await listProviderModels(
      "local",
      { baseUrl: "http://192.168.1.100:11434/v1" },
      fetchImpl as unknown as typeof fetch
    );

    expect(models).toHaveLength(2);
    expect(models[0]).toEqual({
      id: "llama3.2:latest",
      name: "Llama3.2:Latest",
      provider: "local"
    });
    expect(models[1]).toEqual({
      id: "qwen2.5-coder:7b",
      name: "Qwen2.5 Coder:7b",
      provider: "local"
    });

    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://192.168.1.100:11434/api/tags");
    
    // Authorization header should NOT be present when apiKey is empty
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBeUndefined();
  });

  it("resolves custom local baseUrl with trailing slash appropriately", async () => {
    const fetchImpl = mockFetch({ json: { models: [] } });

    await listProviderModels(
      "local",
      { baseUrl: "http://my-ollama:8000/v1/" },
      fetchImpl as unknown as typeof fetch
    );

    const [url1] = fetchImpl.mock.calls[0] as [string];
    expect(url1).toBe("http://my-ollama:8000/api/tags");

    const fetchImpl2 = mockFetch({ json: { models: [] } });
    await listProviderModels(
      "local",
      { baseUrl: "http://my-ollama:9000/" },
      fetchImpl2 as unknown as typeof fetch
    );

    const [url2] = fetchImpl2.mock.calls[0] as [string];
    expect(url2).toBe("http://my-ollama:9000/api/tags");
  });

  it("appends Authorization: Bearer header only when apiKey is non-empty", async () => {
    const fetchImpl = mockFetch({ json: { data: [{ id: "gpt-4o" }] } });

    await listProviderModels(
      "openai",
      { apiKey: "test-api-token" },
      fetchImpl as unknown as typeof fetch
    );

    const [_, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer test-api-token");
  });

  it("always includes custom configured model from profile as fallback", async () => {
    const fetchImpl = mockFetch({
      json: {
        models: [
          { name: "other-model:latest" }
        ]
      }
    });

    const models = await listProviderModels(
      "local",
      { baseUrl: "http://localhost:11434/v1", model: "my-custom-model" },
      fetchImpl as unknown as typeof fetch
    );

    // Both my-custom-model and the fetched other-model should be in the list
    expect(models).toHaveLength(2);
    expect(models[0].id).toBe("my-custom-model");
    expect(models[0].name).toBe("My Custom Model");
    expect(models[1].id).toBe("other-model:latest");

    // Test when the endpoint call fails completely
    const fetchImplFail = mockFetch({ ok: false, status: 500 });
    const modelsFail = await listProviderModels(
      "local",
      { baseUrl: "http://localhost:11434/v1", model: "my-custom-model" },
      fetchImplFail as unknown as typeof fetch
    );

    expect(modelsFail).toHaveLength(1);
    expect(modelsFail[0].id).toBe("my-custom-model");
  });

  it("queries standard OpenAI-compatible /models endpoint for custom providers", async () => {
    const fetchImpl = mockFetch({
      json: {
        data: [
          { id: "custom-model-1" },
          { id: "custom-model-2" }
        ]
      }
    });

    const models = await listProviderModels(
      "my-custom-provider",
      { baseUrl: "https://api.custom.com/v1", apiKey: "my-key" },
      fetchImpl as unknown as typeof fetch
    );

    expect(models).toHaveLength(2);
    expect(models[0].id).toBe("custom-model-1");
    expect(models[1].id).toBe("custom-model-2");

    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.custom.com/v1/models");
    
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer my-key");
  });
});
