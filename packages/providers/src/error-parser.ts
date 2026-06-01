import type { ChatMessage } from "./types.js";

/**
 * Detects context or token overflow errors from any provider based on broad keywords.
 */
export function isContextLimitError(error: unknown): boolean {
  if (!error) return false;
  const message = typeof error === "string"
    ? error
    : error instanceof Error
      ? error.message
      : String(error);

  const lower = message.toLowerCase();

  const keywords = [
    "context_length_exceeded",
    "context length",
    "context window",
    "token limit",
    "max tokens",
    "prompt is too long",
    "too many tokens",
    "maximum context length",
    "exceeded the maximum",
    "maximum of",
    "context window limit",
    "too long"
  ];

  return keywords.some(kw => lower.includes(kw));
}

/**
 * Scans error message for exact token limits using regex patterns or common limit heuristics.
 */
export function parseContextLimit(errorMessage: string): number | null {
  const lower = errorMessage.toLowerCase();

  const patterns = [
    /(?:limit of|maximum of|length is|limit:|limit is|max context length is|max context length of)\s*([\d,]+)/i,
    /([\d,]+)\s*(?:tokens?\b.*?(?:exceed|limit)|tokens?\s*limit)/i,
  ];

  for (const pat of patterns) {
    const match = errorMessage.match(pat);
    if (match && match[1]) {
      const num = parseInt(match[1].replace(/,/g, ""), 10);
      if (!isNaN(num) && num >= 1000) {
        return num;
      }
    }
  }

  // Fallback heuristic: check for common exact token limits in the message
  const commonLimits = [
    1000000, 512000, 262144, 256000, 200000, 131072, 128000, 65536, 32768, 16384, 8192
  ];
  for (const limit of commonLimits) {
    if (lower.includes(String(limit))) {
      return limit;
    }
  }

  return null;
}

// Conservative chars-per-token: code, JSON and tool results — which dominate
// agent turns — tokenize denser than prose, and non-ASCII costs more, so the
// naive 4 under-counts. 3.5 deliberately err's HIGH.
const CHARS_PER_TOKEN_CONSERVATIVE = 3.5;
// Per-message structural overhead (role wrapper + message framing), also on the
// high side.
const PER_MESSAGE_OVERHEAD = 8;
// Coarse upper-bound token cost of an inline image part (multimodal, §8.4).
const IMAGE_PART_TOKENS = 1200;

/**
 * Estimated token count of a messages array — deliberately an OVER-estimate.
 *
 * This single canonical estimator is the proactive half of overflow protection
 * (it gates compaction in `compactTurnHistory` and the reactive
 * `reduceHistoryToFit`). Erring high means we compact/trim a turn slightly too
 * early rather than under-count, send an oversized prompt, and have the provider
 * reject it — the minimax-on-NVIDIA crash (the old `len/4` under-counted 197270
 * real tokens as 192627). It also handles non-string content so multimodal
 * messages (§8.4) don't break it.
 */
export function estimateMessagesTokens(messages: ChatMessage[]): number {
  let total = 0;
  for (const msg of messages) {
    total += estimateContentTokens((msg as { content?: unknown })?.content);
    total += PER_MESSAGE_OVERHEAD;
  }
  return Math.ceil(total);
}

function estimateContentTokens(content: unknown): number {
  if (typeof content === "string") {
    return content.length / CHARS_PER_TOKEN_CONSERVATIVE;
  }
  if (Array.isArray(content)) {
    // Multimodal content parts: { type:"text", text } | { type:"image", ... }.
    let t = 0;
    for (const part of content) {
      if (part && typeof part === "object") {
        const p = part as { text?: unknown };
        if (typeof p.text === "string") t += p.text.length / CHARS_PER_TOKEN_CONSERVATIVE;
        else t += IMAGE_PART_TOKENS;
      }
    }
    return t;
  }
  if (content == null) return 0;
  try {
    return String(content).length / CHARS_PER_TOKEN_CONSERVATIVE;
  } catch {
    return 0;
  }
}
