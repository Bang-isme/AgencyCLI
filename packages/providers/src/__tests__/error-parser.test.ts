import { describe, expect, it } from "vitest";
import {
  estimateMessagesTokens,
  parseContextLimit,
  isContextLimitError,
} from "../error-parser.js";
import type { ChatMessage } from "../types.js";

describe("estimateMessagesTokens (§8.3 — err HIGH)", () => {
  it("over-estimates relative to the naive chars/4 (never under-counts)", () => {
    const content = "x".repeat(40000); // 40k chars
    const msgs: ChatMessage[] = [{ role: "user", content }];
    const naive = Math.round(content.length / 4); // 10000
    const est = estimateMessagesTokens(msgs);
    expect(est).toBeGreaterThan(naive);
  });

  it("adds per-message structural overhead", () => {
    const one: ChatMessage[] = [{ role: "user", content: "" }];
    const three: ChatMessage[] = [
      { role: "system", content: "" },
      { role: "user", content: "" },
      { role: "assistant", content: "" },
    ];
    expect(estimateMessagesTokens(three)).toBeGreaterThan(estimateMessagesTokens(one));
  });

  it("does not throw on non-string content (multimodal forward-compat)", () => {
    const msgs = [
      { role: "user", content: undefined },
      { role: "user", content: null },
      { role: "user", content: [{ type: "text", text: "hello" }, { type: "image", url: "x" }] },
    ] as unknown as ChatMessage[];
    expect(() => estimateMessagesTokens(msgs)).not.toThrow();
    // The image part contributes a coarse positive token cost.
    expect(estimateMessagesTokens(msgs)).toBeGreaterThan(0);
  });
});

describe("parseContextLimit", () => {
  it("extracts the real limit from a provider overflow message", () => {
    const msg =
      "nvidia API error: This model's maximum context length is 196608 tokens. However, your messages resulted in 197270 tokens";
    expect(parseContextLimit(msg)).toBe(196608);
  });
});

describe("isContextLimitError", () => {
  it("recognises a maximum-context-length error", () => {
    expect(
      isContextLimitError(new Error("This model's maximum context length is 196608 tokens"))
    ).toBe(true);
  });
  it("ignores unrelated errors", () => {
    expect(isContextLimitError(new Error("ECONNRESET"))).toBe(false);
  });
});
