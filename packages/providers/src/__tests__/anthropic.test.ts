import { describe, expect, it, vi, type Mock } from "vitest";
import { createAnthropicProvider } from "../anthropic.js";

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

describe("anthropic provider complete & streamComplete", () => {
  it("complete(): injects thinking block, deletes temperature, expands max_tokens", async () => {
    const fetchImpl = mockFetch({
      json: {
        content: [
          { type: "thinking", thinking: "I am thinking" },
          { type: "text", text: "Hello" },
        ],
        usage: { input_tokens: 10, output_tokens: 20 },
      },
    });

    const provider = createAnthropicProvider(
      {
        apiKey: "test-key",
        model: "claude-3-7-sonnet", // budget-based model
        thinking: 2048, // custom budget 2048 tokens
      },
      fetchImpl as unknown as typeof fetch
    );

    const onOptimization = vi.fn();
    const result = await provider.complete([{ role: "user", content: "Hi" }], {
      onOptimization,
      maxTokens: 1000,
      temperature: 0.7,
    });

    expect(result).toBe("Hello");
    expect(onOptimization).toHaveBeenCalledOnce();
    expect(onOptimization).toHaveBeenCalledWith({
      budget: 2048,
      intent: "chat",
      type: "budget",
    });

    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    const body = JSON.parse(String(init.body));
    expect(body.thinking).toEqual({
      type: "enabled",
      budget_tokens: 2048,
    });
    // Anthropic API requires no temperature when thinking is enabled
    expect(body.temperature).toBeUndefined();
    // body.max_tokens should be expanded to budget_tokens + 1024
    expect(body.max_tokens).toBe(2048 + 1024);
  });

  it("complete(): leaves standard params untouched when thinking is off or not supported", async () => {
    const fetchImpl = mockFetch({
      json: {
        content: [{ type: "text", text: "Hello" }],
      },
    });

    const provider = createAnthropicProvider(
      {
        apiKey: "test-key",
        model: "claude-3-5-sonnet", // not thinking supported in registry
        thinking: "off",
      },
      fetchImpl as unknown as typeof fetch
    );

    await provider.complete([{ role: "user", content: "Hi" }], {
      temperature: 0.5,
      maxTokens: 500,
    });

    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(init.body));
    expect(body.thinking).toBeUndefined();
    expect(body.temperature).toBe(0.5);
    expect(body.max_tokens).toBe(500);
  });
});
