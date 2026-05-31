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

/**
 * Computes an estimated token count of the given messages array (~4 characters per token + overhead).
 */
export function estimateMessagesTokens(messages: ChatMessage[]): number {
  let totalChars = 0;
  for (const msg of messages) {
    totalChars += (msg.content || "").length;
  }
  const estimatedTokens = Math.round(totalChars / 4);
  const overhead = messages.length * 5;
  return estimatedTokens + overhead;
}
