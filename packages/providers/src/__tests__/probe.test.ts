import { describe, expect, it, vi } from "vitest";
import { probeModel } from "../probe.js";
import type { AgencyConfig } from "../types.js";

describe("probeModel Suite", () => {
  const dummyConfig: AgencyConfig = {
    defaultProvider: "openai",
    providers: {
      openai: {
        apiKey: "sk-dummy-key",
        baseUrl: "https://api.openai.com/v1",
        model: "gpt-4o",
      },
    },
    modelOverrides: {},
  };

  it("should return failure if API key is missing", async () => {
    const configNoKey: AgencyConfig = {
      defaultProvider: "openai",
      providers: {
        openai: {
          baseUrl: "https://api.openai.com/v1",
        },
      },
    };
    const res = await probeModel("openai", "gpt-4o", configNoKey);
    expect(res.success).toBe(false);
    expect(res.traceLogs.some((l) => l.includes("Thiếu API Key"))).toBe(true);
  });

  it("should probe reasoning, max output, and tools successfully", async () => {
    let callIndex = 0;
    const mockFetch = vi.fn().mockImplementation(async (url: string, opts: any) => {
      callIndex++;
      
      // Step 1: /v1/models (metadata list)
      if (url.endsWith("/models")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            data: [
              { id: "gpt-4o", context_window: 128000, max_completion_tokens: 16384 }
            ]
          }),
          text: async () => ""
        };
      }

      // Step 2: reasoning_effort test
      if (callIndex === 2) {
        // Mock success for reasoning_effort
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ choices: [{ message: { content: "ok" } }] }),
          json: async () => ({ choices: [{ message: { content: "ok" } }] })
        };
      }

      // Step 3: reasoning content test
      if (callIndex === 3) {
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({
            choices: [{
              message: {
                content: "Xin chào",
                reasoning_content: "Thinking steps..."
              }
            }]
          }),
          json: async () => ({
            choices: [{
              message: {
                content: "Xin chào",
                reasoning_content: "Thinking steps..."
              }
            }]
          })
        };
      }

      // Step 4: max_tokens overflow validation test
      if (callIndex === 4) {
        return {
          ok: false,
          status: 400,
          text: async () => "max_tokens must be less than or equal to 8192",
          json: async () => null
        };
      }

      // Step 5: tools test
      if (callIndex === 5) {
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ choices: [{ message: { content: "ok" } }] }),
          json: async () => ({ choices: [{ message: { content: "ok" } }] })
        };
      }

      return {
        ok: true,
        status: 200,
        text: async () => "{}",
        json: async () => ({})
      };
    });

    const res = await probeModel("openai", "gpt-4o", dummyConfig, mockFetch as any);

    expect(res.success).toBe(true);
    expect(res.contextWindow).toBe(128000);
    expect(res.maxOutputTokens).toBe(8192); // Extracted from error validation regex!
    expect(res.thinkingType).toBe("effort"); // Detected effort parameter success
    expect(res.supportsTools).toBe(true);
    expect(res.rawDetails.effortSupported).toBe(true);
    expect(res.rawDetails.nativeReasoningTokens).toBe(true);
  });
});
