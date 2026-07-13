import { describe, expect, it, vi } from "vitest";
import { createOpenAiCompatibleProvider } from "../adapters/openai-compatible.js";

function streamResponse(payload: object) {
  const encoder = new TextEncoder();
  const reader = {
    read: vi
      .fn()
      .mockResolvedValueOnce({ done: false, value: encoder.encode(`data: ${JSON.stringify(payload)}\n\n`) })
      .mockResolvedValueOnce({ done: true }),
    cancel: vi.fn().mockResolvedValue(undefined),
    releaseLock: vi.fn(),
  };
  return {
    reader,
    fetchImpl: vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers(),
      body: { getReader: () => reader },
    }),
  };
}

describe("OpenRouter reasoning compatibility", () => {
  it("keeps the canonical reasoning field out of visible streamed content", async () => {
    const { fetchImpl } = streamResponse({
      choices: [{ delta: { reasoning: "internal diagnostic", content: "visible answer" } }],
    });
    const onDelta = vi.fn();
    const onThought = vi.fn();
    const provider = createOpenAiCompatibleProvider({
      id: "openrouter", apiKey: "test", baseUrl: "https://openrouter.ai/api/v1", defaultModel: "minimax/m3",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await expect(provider.streamComplete([{ role: "user", content: "hi" }], { onDelta, onThought }))
      .resolves.toBe("visible answer");
    expect(onThought).toHaveBeenCalledWith("internal diagnostic");
    expect(onDelta).toHaveBeenCalledWith("visible answer");
  });

  it("routes structured reasoning details to the thought channel", async () => {
    const { fetchImpl } = streamResponse({
      choices: [{ delta: { reasoning_details: [{ text: "first" }, { summary: "second" }], content: "done" } }],
    });
    const onThought = vi.fn();
    const provider = createOpenAiCompatibleProvider({
      id: "openrouter", apiKey: "test", baseUrl: "https://openrouter.ai/api/v1", defaultModel: "minimax/m3",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await provider.streamComplete([{ role: "user", content: "hi" }], { onDelta: () => {}, onThought });
    expect(onThought).toHaveBeenCalledWith("firstsecond");
  });
});
