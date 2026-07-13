import { describe, expect, it, vi } from "vitest";
import { createAnthropicProvider } from "../anthropic.js";
import { createGoogleProvider } from "../google.js";
import { createOpenAiCompatibleProvider } from "../adapters/openai-compatible.js";

describe("Milestone 10 Challenger Extra: Stream Callback Exception Propagation", () => {
  describe("OpenAI Compatible Provider Callbacks", () => {
    it("releases lock and cancels reader if onThought throws", async () => {
      const encoder = new TextEncoder();
      const mockReader = {
        read: vi
          .fn()
          .mockResolvedValueOnce({
            done: false,
            value: encoder.encode('data: {"choices": [{"delta": {"content": "hello", "reasoning_content": "thinking"}}]}\n\n'),
          })
          .mockResolvedValueOnce({ done: true }),
        cancel: vi.fn().mockResolvedValue(undefined),
        releaseLock: vi.fn(),
      };
      const mockBody = {
        getReader: () => mockReader,
      };
      const fetchImpl = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        body: mockBody,
      });

      const provider = createOpenAiCompatibleProvider({
        id: "openai",
        apiKey: "test-key",
        baseUrl: "https://api.example.com/v1",
        defaultModel: "gpt-test",
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });

      const onThought = vi.fn().mockImplementation(() => {
        throw new Error("Thought callback error");
      });

      await expect(
        provider.streamComplete([{ role: "user", content: "Hi" }], { onDelta: () => {}, onThought })
      ).rejects.toThrow("Thought callback error");

      expect(mockReader.cancel).toHaveBeenCalled();
      expect(mockReader.releaseLock).toHaveBeenCalled();
    });

    it("releases lock and cancels reader if onUsage throws", async () => {
      const encoder = new TextEncoder();
      const mockReader = {
        read: vi
          .fn()
          .mockResolvedValueOnce({
            done: false,
            value: encoder.encode('data: {"choices": [{"delta": {"content": "hello"}}], "usage": {"prompt_tokens": 10, "completion_tokens": 5}}\n\n'),
          })
          .mockResolvedValueOnce({ done: true }),
        cancel: vi.fn().mockResolvedValue(undefined),
        releaseLock: vi.fn(),
      };
      const mockBody = {
        getReader: () => mockReader,
      };
      const fetchImpl = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        body: mockBody,
      });

      const provider = createOpenAiCompatibleProvider({
        id: "openai",
        apiKey: "test-key",
        baseUrl: "https://api.example.com/v1",
        defaultModel: "gpt-test",
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });

      const onUsage = vi.fn().mockImplementation(() => {
        throw new Error("Usage callback error");
      });

      await expect(
        provider.streamComplete([{ role: "user", content: "Hi" }], { onDelta: () => {}, onUsage })
      ).rejects.toThrow("Usage callback error");

      expect(mockReader.cancel).toHaveBeenCalled();
      expect(mockReader.releaseLock).toHaveBeenCalled();
    });

    it("releases lock and cancels reader if onFinishReason throws", async () => {
      const encoder = new TextEncoder();
      const mockReader = {
        read: vi
          .fn()
          .mockResolvedValueOnce({
            done: false,
            value: encoder.encode('data: {"choices": [{"delta": {"content": "hello"}, "finish_reason": "stop"}]}\n\n'),
          })
          .mockResolvedValueOnce({ done: true }),
        cancel: vi.fn().mockResolvedValue(undefined),
        releaseLock: vi.fn(),
      };
      const mockBody = {
        getReader: () => mockReader,
      };
      const fetchImpl = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        body: mockBody,
      });

      const provider = createOpenAiCompatibleProvider({
        id: "openai",
        apiKey: "test-key",
        baseUrl: "https://api.example.com/v1",
        defaultModel: "gpt-test",
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });

      const onFinishReason = vi.fn().mockImplementation(() => {
        throw new Error("FinishReason callback error");
      });

      await expect(
        provider.streamComplete([{ role: "user", content: "Hi" }], { onDelta: () => {}, onFinishReason })
      ).rejects.toThrow("FinishReason callback error");

      expect(mockReader.cancel).toHaveBeenCalled();
      expect(mockReader.releaseLock).toHaveBeenCalled();
    });
  });

  describe("Anthropic Provider Callbacks", () => {
    it("releases lock and cancels reader if onThought throws", async () => {
      const encoder = new TextEncoder();
      const mockReader = {
        read: vi
          .fn()
          .mockResolvedValueOnce({
            done: false,
            value: encoder.encode('data: {"type": "content_block_delta", "delta": {"type": "thinking_delta", "thinking": "reasoning"}}\n\n'),
          })
          .mockResolvedValueOnce({ done: true }),
        cancel: vi.fn().mockResolvedValue(undefined),
        releaseLock: vi.fn(),
      };
      const mockBody = {
        getReader: () => mockReader,
      };
      const fetchImpl = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        body: mockBody,
        headers: new Headers(),
      });

      const provider = createAnthropicProvider(
        { apiKey: "test-key", model: "claude-3-5-sonnet" },
        fetchImpl as unknown as typeof fetch
      );

      const onThought = vi.fn().mockImplementation(() => {
        throw new Error("Anthropic Thought callback error");
      });

      await expect(
        provider.streamComplete([{ role: "user", content: "Hi" }], { onDelta: () => {}, onThought })
      ).rejects.toThrow("Anthropic Thought callback error");

      expect(mockReader.cancel).toHaveBeenCalled();
      expect(mockReader.releaseLock).toHaveBeenCalled();
    });

    it("releases lock and cancels reader if onFinishReason throws", async () => {
      const encoder = new TextEncoder();
      const mockReader = {
        read: vi
          .fn()
          .mockResolvedValueOnce({
            done: false,
            value: encoder.encode('data: {"type": "message_delta", "delta": {"stop_reason": "end_turn"}}\n\n'),
          })
          .mockResolvedValueOnce({ done: true }),
        cancel: vi.fn().mockResolvedValue(undefined),
        releaseLock: vi.fn(),
      };
      const mockBody = {
        getReader: () => mockReader,
      };
      const fetchImpl = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        body: mockBody,
        headers: new Headers(),
      });

      const provider = createAnthropicProvider(
        { apiKey: "test-key", model: "claude-3-5-sonnet" },
        fetchImpl as unknown as typeof fetch
      );

      const onFinishReason = vi.fn().mockImplementation(() => {
        throw new Error("Anthropic FinishReason callback error");
      });

      await expect(
        provider.streamComplete([{ role: "user", content: "Hi" }], { onDelta: () => {}, onFinishReason })
      ).rejects.toThrow("Anthropic FinishReason callback error");

      expect(mockReader.cancel).toHaveBeenCalled();
      expect(mockReader.releaseLock).toHaveBeenCalled();
    });
  });

  describe("Google Provider Callbacks", () => {
    it("releases lock and cancels reader if onThought throws", async () => {
      const encoder = new TextEncoder();
      const mockReader = {
        read: vi
          .fn()
          .mockResolvedValueOnce({
            done: false,
            value: encoder.encode('{"candidates": [{"content": {"parts": [{"text": "thinking", "thought": true}]}}]}'),
          })
          .mockResolvedValueOnce({ done: true }),
        cancel: vi.fn().mockResolvedValue(undefined),
        releaseLock: vi.fn(),
      };
      const mockBody = {
        getReader: () => mockReader,
      };
      const fetchImpl = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        body: mockBody,
        headers: new Headers(),
      });

      const provider = createGoogleProvider(
        { apiKey: "test-key", model: "gemini-2.5-flash" },
        fetchImpl as unknown as typeof fetch
      );

      const onThought = vi.fn().mockImplementation(() => {
        throw new Error("Google Thought callback error");
      });

      await expect(
        provider.streamComplete([{ role: "user", content: "Hi" }], { onDelta: () => {}, onThought })
      ).rejects.toThrow("Google Thought callback error");

      expect(mockReader.cancel).toHaveBeenCalled();
      expect(mockReader.releaseLock).toHaveBeenCalled();
    });

    it("releases lock and cancels reader if onFinishReason throws", async () => {
      const encoder = new TextEncoder();
      const mockReader = {
        read: vi
          .fn()
          .mockResolvedValueOnce({
            done: false,
            value: encoder.encode('{"candidates": [{"finishReason": "STOP"}]}'),
          })
          .mockResolvedValueOnce({ done: true }),
        cancel: vi.fn().mockResolvedValue(undefined),
        releaseLock: vi.fn(),
      };
      const mockBody = {
        getReader: () => mockReader,
      };
      const fetchImpl = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        body: mockBody,
        headers: new Headers(),
      });

      const provider = createGoogleProvider(
        { apiKey: "test-key", model: "gemini-2.5-flash" },
        fetchImpl as unknown as typeof fetch
      );

      const onFinishReason = vi.fn().mockImplementation(() => {
        throw new Error("Google FinishReason callback error");
      });

      await expect(
        provider.streamComplete([{ role: "user", content: "Hi" }], { onDelta: () => {}, onFinishReason })
      ).rejects.toThrow("Google FinishReason callback error");

      expect(mockReader.cancel).toHaveBeenCalled();
      expect(mockReader.releaseLock).toHaveBeenCalled();
    });

    it("releases lock and cancels reader if onUsage throws", async () => {
      const encoder = new TextEncoder();
      const mockReader = {
        read: vi
          .fn()
          .mockResolvedValueOnce({
            done: false,
            value: encoder.encode('{"candidates": [], "usageMetadata": {"promptTokenCount": 10, "candidatesTokenCount": 5}}'),
          })
          .mockResolvedValueOnce({ done: true }),
        cancel: vi.fn().mockResolvedValue(undefined),
        releaseLock: vi.fn(),
      };
      const mockBody = {
        getReader: () => mockReader,
      };
      const fetchImpl = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        body: mockBody,
        headers: new Headers(),
      });

      const provider = createGoogleProvider(
        { apiKey: "test-key", model: "gemini-2.5-flash" },
        fetchImpl as unknown as typeof fetch
      );

      const onUsage = vi.fn().mockImplementation(() => {
        throw new Error("Google Usage callback error");
      });

      await expect(
        provider.streamComplete([{ role: "user", content: "Hi" }], { onDelta: () => {}, onUsage })
      ).rejects.toThrow("Google Usage callback error");

      expect(mockReader.cancel).toHaveBeenCalled();
      expect(mockReader.releaseLock).toHaveBeenCalled();
    });
  });
});
