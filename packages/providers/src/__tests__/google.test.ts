import { describe, expect, it, vi, type Mock } from "vitest";
import { createGoogleProvider } from "../google.js";

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

describe("google provider complete & streamComplete", () => {
  it("complete(): enables thinking budget in payload when model is budget-based", async () => {
    const fetchImpl = mockFetch({
      json: {
        candidates: [
          {
            content: { parts: [{ text: "Hello" }] },
            finishReason: "STOP",
          },
        ],
        usageMetadata: {
          promptTokenCount: 10,
          candidatesTokenCount: 5,
        },
      },
    });

    const provider = createGoogleProvider(
      {
        apiKey: "test-key",
        model: "gemini-2.0-flash", // flash has thinking type budget
        thinking: "high", // 50% variant
      },
      fetchImpl as unknown as typeof fetch
    );

    const onOptimization = vi.fn();
    const onUsage = vi.fn();

    const result = await provider.complete([{ role: "user", content: "Hi" }], {
      onOptimization,
      onUsage,
    });

    expect(result).toBe("Hello");
    expect(onOptimization).toHaveBeenCalledOnce();
    expect(onOptimization).toHaveBeenCalledWith({
      budget: 2048, // 25% of 8192 for chat intent under high variant
      intent: "chat",
      type: "budget",
    });

    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("generativelanguage.googleapis.com");
    const body = JSON.parse(String(init.body));
    expect(body.generationConfig.thinkingConfig.thinkingBudget).toBe(2048);
  });

  it("complete(): disables thinking budget in payload when model is none thinking type", async () => {
    const fetchImpl = mockFetch({
      json: {
        candidates: [{ content: { parts: [{ text: "Hello" }] } }],
      },
    });

    const provider = createGoogleProvider(
      {
        apiKey: "test-key",
        model: "gemini-1.5-flash", // none thinking type
        thinking: "off",
      },
      fetchImpl as unknown as typeof fetch
    );

    await provider.complete([{ role: "user", content: "Hi" }]);

    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(init.body));
    expect(body.generationConfig.thinkingConfig).toBeUndefined();
  });
});
