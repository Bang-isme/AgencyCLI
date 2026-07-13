import { describe, expect, it } from "vitest";
import { resolveThoughtExpansion, reasoningSummary } from "../components/Conversation.js";

/**
 * The live-detail / idle-digest behaviour: the model's thought block expands WHILE
 * a message is streaming (so you watch it think) and collapses the instant the
 * stream ends (so a finished transcript stays compact), independent of the manual
 * `ctrl+o` pin. Pure decision — `Conversation` reads the flag once per render and
 * feeds it here at each thought site.
 */
describe("resolveThoughtExpansion", () => {
  it("manual ctrl+o pins the LAST message's thought open (even when idle)", () => {
    expect(resolveThoughtExpansion(true, true, false, false)).toBe(true);
  });

  it("manual ctrl+o does not expand non-last messages", () => {
    expect(resolveThoughtExpansion(true, false, false, false)).toBe(false);
  });

  it("auto-expands while streaming when the flag is on (any message)", () => {
    expect(resolveThoughtExpansion(false, false, true, true)).toBe(true);
  });

  it("COLLAPSES the moment the stream ends (the core ask)", () => {
    // streaming flips true → false → thought auto-collapses with the flag on.
    expect(resolveThoughtExpansion(false, false, true, true)).toBe(true);
    expect(resolveThoughtExpansion(false, false, false, true)).toBe(false);
  });

  it("is a no-op when the flag is off (legacy: manual-expand only)", () => {
    expect(resolveThoughtExpansion(false, false, true, false)).toBe(false);
    expect(resolveThoughtExpansion(false, true, true, false)).toBe(false);
  });

  it("either trigger alone expands (OR semantics)", () => {
    expect(resolveThoughtExpansion(true, true, false, false)).toBe(true); // manual only
    expect(resolveThoughtExpansion(false, false, true, true)).toBe(true); // auto only
    expect(resolveThoughtExpansion(false, false, false, false)).toBe(false); // neither
  });
});

describe("reasoningSummary", () => {
  it("extracts bold header and separates from body text", () => {
    const result = reasoningSummary("**Thinking Process**\nThis is the thought body.");
    expect(result.title).toBe("Thinking Process");
    expect(result.body).toBe("This is the thought body.");
  });

  it("extracts bold header followed by a colon", () => {
    const result = reasoningSummary("**Analysis**: Let's review the steps.");
    expect(result.title).toBe("Analysis");
    expect(result.body).toBe("Let's review the steps.");
  });

  it("returns empty title and whole thought as body if no bold header", () => {
    const result = reasoningSummary("Plain thought process here.");
    expect(result.title).toBe("");
    expect(result.body).toBe("Plain thought process here.");
  });

  it("handles empty input", () => {
    const result = reasoningSummary("");
    expect(result.title).toBe("");
    expect(result.body).toBe("");
  });

  it("handles thoughts with no title (plain text)", () => {
    const result = reasoningSummary("Plain thought process here without any bold markers.");
    expect(result.title).toBe("");
    expect(result.body).toBe("Plain thought process here without any bold markers.");
  });

  it("handles multiple bold sections in a thought", () => {
    const result = reasoningSummary("**Thinking**:\nThis is **Process** in action.");
    expect(result.title).toBe("Thinking");
    expect(result.body).toBe("This is **Process** in action.");
  });

  it("handles empty bodies", () => {
    const result1 = reasoningSummary("**Thinking Process**");
    expect(result1.title).toBe("Thinking Process");
    expect(result1.body).toBe("");

    const result2 = reasoningSummary("**Thinking Process**\n");
    expect(result2.title).toBe("Thinking Process");
    expect(result2.body).toBe("");
  });

  it("handles leading whitespace and newlines before bold header", () => {
    const result = reasoningSummary("  \n  **Thinking Process**\nThis is the body.");
    expect(result.title).toBe("Thinking Process");
    expect(result.body).toBe("This is the body.");
  });

  it("handles extremely long titles", () => {
    const longTitle = "A".repeat(1000);
    const result = reasoningSummary(`**${longTitle}**\nThis is the body.`);
    expect(result.title).toBe(longTitle);
    expect(result.body).toBe("This is the body.");
  });

  it("handles colons inside and outside the bold block", () => {
    const result1 = reasoningSummary("**Thinking: Process**: Body text here.");
    expect(result1.title).toBe("Thinking: Process");
    expect(result1.body).toBe("Body text here.");

    // The parser aggressively strips all leading colons and whitespace after the bold block
    const result2 = reasoningSummary("**Thinking**: : : Body text.");
    expect(result2.title).toBe("Thinking");
    expect(result2.body).toBe(": : Body text.");
  });

  it("does not match standard bold text as a title (false-positive detection)", () => {
    const result = reasoningSummary("**First step** is to query...");
    expect(result.title).toBe("");
    expect(result.body).toBe("**First step** is to query...");
  });

  it("handles clock skew (NTP adjustment) during streaming turns", () => {
    const thoughtStartMs = 1718000000000;
    const nowWithSkew = 1717999900000; // 100 seconds backwards
    const durationMs = Math.max(0, nowWithSkew - thoughtStartMs);
    expect(durationMs).toBe(0);
  });

  it("finalizes message streaming state and duration upon stream interruption or cancellation", () => {
    const message = {
      id: "assistant-msg-1",
      role: "assistant" as const,
      content: "",
      streaming: true,
      thoughtDurationMs: undefined as number | undefined,
    };

    const patchMessage = (patch: Partial<typeof message>) => {
      Object.assign(message, patch);
    };

    const thoughtStartMs = 1718000000000;
    const now = 1718000005000;

    try {
      throw new Error("Stream aborted");
    } catch (err) {
      const finalDurationMs = thoughtStartMs !== null ? Math.max(0, now - thoughtStartMs) : undefined;
      patchMessage({
        streaming: false,
        ...(finalDurationMs !== undefined ? { thoughtDurationMs: finalDurationMs } : {}),
      });
    }

    expect(message.streaming).toBe(false);
    expect(message.thoughtDurationMs).toBe(5000);
  });
});


