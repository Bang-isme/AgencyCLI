/** Parse OpenAI-compatible chat completion SSE chunks from a text buffer. */
export function parseOpenAiSseBuffer(buffer: string): {
  deltas: string[];
  remainder: string;
} {
  const lines = buffer.split("\n");
  const remainder = lines.pop() ?? "";
  const deltas: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const payload = trimmed.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    try {
      const json = JSON.parse(payload) as {
        choices?: Array<{ delta?: { content?: string } }>;
      };
      const piece = json.choices?.[0]?.delta?.content;
      if (typeof piece === "string" && piece.length > 0) {
        deltas.push(piece);
      }
    } catch {
      // ignore malformed SSE frames
    }
  }

  return { deltas, remainder };
}
