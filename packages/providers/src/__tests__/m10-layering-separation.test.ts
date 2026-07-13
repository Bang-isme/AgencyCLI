import { describe, expect, it, vi } from "vitest";
import { createAnthropicProvider } from "../anthropic.js";
import { createGoogleProvider } from "../google.js";
import { createOpenAiCompatibleProvider } from "../adapters/openai-compatible.js";
import type { Transport, TransportRequest, TransportResponse } from "../types.js";

// Helper to create a mock stream with releaseLock and cancel tracking
function createMockStream(chunks: string[], throwOnIndex?: number) {
  let cancelCalled = false;
  let releaseLockCalled = false;
  
  const encoder = new TextEncoder();
  const readable = new ReadableStream<Uint8Array>({
    async start(controller) {
      for (let i = 0; i < chunks.length; i++) {
        controller.enqueue(encoder.encode(chunks[i]));
      }
      if (throwOnIndex !== undefined) {
        controller.error(new Error("Simulated stream error"));
      } else {
        controller.close();
      }
    },
    cancel() {
      cancelCalled = true;
    }
  });

  const originalGetReader = readable.getReader.bind(readable);
  readable.getReader = () => {
    const reader = originalGetReader();
    const originalCancel = reader.cancel.bind(reader);
    const originalReleaseLock = reader.releaseLock.bind(reader);

    reader.cancel = async () => {
      cancelCalled = true;
      return originalCancel();
    };
    reader.releaseLock = () => {
      releaseLockCalled = true;
      originalReleaseLock();
    };
    return reader;
  };

  return {
    readable,
    getCancelCalled: () => cancelCalled,
    getReleaseLockCalled: () => releaseLockCalled
  };
}

class MockTransport implements Transport {
  requests: TransportRequest[] = [];
  responseMock: () => Promise<TransportResponse>;

  constructor(responseMock: () => Promise<TransportResponse>) {
    this.responseMock = responseMock;
  }

  async request(req: TransportRequest): Promise<TransportResponse> {
    this.requests.push(req);
    return this.responseMock();
  }
}

describe("Milestone 10: Client/Transport Layering Separation", () => {
  describe("Anthropic Provider Decoupling", () => {
    it("should route all HTTP operations through Transport and release/cancel stream readers on success", async () => {
      const mockStream = createMockStream([
        `data: {"type": "message_start", "message": {"usage": {"input_tokens": 5}}}\n`,
        `data: {"type": "content_block_delta", "delta": {"type": "text_delta", "text": "Hello "}}\n`,
        `data: {"type": "content_block_delta", "delta": {"type": "text_delta", "text": "World!"}}\n`,
        `data: {"type": "message_delta", "usage": {"output_tokens": 10}}\n`
      ]);

      const mockTransport = new MockTransport(async () => ({
        ok: true,
        status: 200,
        headers: new Headers({ "x-api-limit": "100" }),
        body: mockStream.readable,
        json: async () => ({}),
        text: async () => ""
      }));

      const provider = createAnthropicProvider(
        { apiKey: "test-key", model: "claude-3-5-sonnet" },
        mockTransport
      );

      const deltas: string[] = [];
      const result = await provider.streamComplete!(
        [{ role: "user", content: "Hi" }],
        { onDelta: (d) => deltas.push(d) }
      );

      expect(result).toBe("Hello World!");
      expect(deltas).toEqual(["Hello ", "World!"]);
      expect(mockTransport.requests.length).toBe(1);
      expect(mockTransport.requests[0]?.url).toContain("anthropic.com");
      
      // Ensure the stream and reader were closed and released correctly
      expect(mockStream.getCancelCalled()).toBe(true);
      expect(mockStream.getReleaseLockCalled()).toBe(true);
    });

    it("should release/cancel stream readers inside finally block even if stream reading fails", async () => {
      const mockStream = createMockStream([
        `data: {"type": "content_block_delta", "delta": {"type": "text_delta", "text": "Partial"}}\n`
      ], 1); // Throw error on second chunk

      const mockTransport = new MockTransport(async () => ({
        ok: true,
        status: 200,
        headers: new Headers(),
        body: mockStream.readable,
        json: async () => ({}),
        text: async () => ""
      }));

      const provider = createAnthropicProvider(
        { apiKey: "test-key", model: "claude-3-5-sonnet" },
        mockTransport
      );

      await expect(
        provider.streamComplete!(
          [{ role: "user", content: "Hi" }],
          { onDelta: () => {} }
        )
      ).rejects.toThrow();

      // Ensure cleanup ran despite error
      expect(mockStream.getCancelCalled()).toBe(true);
      expect(mockStream.getReleaseLockCalled()).toBe(true);
    });
  });

  describe("Google Provider Decoupling", () => {
    it("should route all HTTP operations through Transport and release/cancel stream readers on success", async () => {
      const mockStream = createMockStream([
        `{"candidates": [{"content": {"parts": [{"text": "Hello Gemini"}]}}]}\n`
      ]);

      const mockTransport = new MockTransport(async () => ({
        ok: true,
        status: 200,
        headers: new Headers(),
        body: mockStream.readable,
        json: async () => ({}),
        text: async () => ""
      }));

      const provider = createGoogleProvider(
        { apiKey: "test-key", model: "gemini-1.5-pro" },
        mockTransport
      );

      const deltas: string[] = [];
      const result = await provider.streamComplete!(
        [{ role: "user", content: "Hi" }],
        { onDelta: (d) => deltas.push(d) }
      );

      expect(result).toBe("Hello Gemini");
      expect(mockTransport.requests.length).toBe(1);
      expect(mockTransport.requests[0]?.url).toContain("googleapis.com");
      expect(mockStream.getCancelCalled()).toBe(true);
      expect(mockStream.getReleaseLockCalled()).toBe(true);
    });

    it("should release/cancel stream readers inside finally block even if stream reading fails", async () => {
      const mockStream = createMockStream([
        `{"candidates": [{"content": {"parts": [{"text": "Partial"}]}}]}`
      ], 1);

      const mockTransport = new MockTransport(async () => ({
        ok: true,
        status: 200,
        headers: new Headers(),
        body: mockStream.readable,
        json: async () => ({}),
        text: async () => ""
      }));

      const provider = createGoogleProvider(
        { apiKey: "test-key", model: "gemini-1.5-pro" },
        mockTransport
      );

      await expect(
        provider.streamComplete!(
          [{ role: "user", content: "Hi" }],
          { onDelta: () => {} }
        )
      ).rejects.toThrow();

      expect(mockStream.getCancelCalled()).toBe(true);
      expect(mockStream.getReleaseLockCalled()).toBe(true);
    });
  });

  describe("OpenAI Compatible Provider Decoupling", () => {
    it("should route all HTTP operations through Transport and release/cancel stream readers on success", async () => {
      const mockStream = createMockStream([
        `data: {"choices": [{"delta": {"content": "Hello OpenAI"}}]}\n`,
        `data: [DONE]\n`
      ]);

      const mockTransport = new MockTransport(async () => ({
        ok: true,
        status: 200,
        headers: new Headers(),
        body: mockStream.readable,
        json: async () => ({}),
        text: async () => ""
      }));

      const provider = createOpenAiCompatibleProvider({
        id: "openai",
        apiKey: "test-key",
        model: "gpt-4o",
        baseUrl: "https://api.openai.com/v1",
        transport: mockTransport
      });

      const deltas: string[] = [];
      const result = await provider.streamComplete!(
        [{ role: "user", content: "Hi" }],
        { onDelta: (d) => deltas.push(d) }
      );

      expect(result).toBe("Hello OpenAI");
      expect(mockTransport.requests.length).toBe(1);
      expect(mockTransport.requests[0]?.url).toContain("openai.com");
      expect(mockStream.getCancelCalled()).toBe(true);
      expect(mockStream.getReleaseLockCalled()).toBe(true);
    });

    it("should release/cancel stream readers inside finally block even if stream reading fails", async () => {
      const mockStream = createMockStream([
        `data: {"choices": [{"delta": {"content": "Partial"}}]}\n`
      ], 1);

      const mockTransport = new MockTransport(async () => ({
        ok: true,
        status: 200,
        headers: new Headers(),
        body: mockStream.readable,
        json: async () => ({}),
        text: async () => ""
      }));

      const provider = createOpenAiCompatibleProvider({
        id: "openai",
        apiKey: "test-key",
        model: "gpt-4o",
        baseUrl: "https://api.openai.com/v1",
        transport: mockTransport
      });

      await expect(
        provider.streamComplete!(
          [{ role: "user", content: "Hi" }],
          { onDelta: () => {} }
        )
      ).rejects.toThrow();

      expect(mockStream.getCancelCalled()).toBe(true);
      expect(mockStream.getReleaseLockCalled()).toBe(true);
    });
  });
});
