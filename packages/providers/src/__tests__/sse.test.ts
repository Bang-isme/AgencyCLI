import { describe, expect, it } from "vitest";
import { parseOpenAiSseBuffer } from "../sse.js";

describe("parseOpenAiSseBuffer", () => {
  it("extracts delta content from SSE lines", () => {
    const chunk = [
      'data: {"choices":[{"delta":{"content":"Hel"}}]}',
      "",
      'data: {"choices":[{"delta":{"content":"lo"}}]}',
      "",
      "data: [DONE]",
      "",
    ].join("\n");

    const { deltas, remainder } = parseOpenAiSseBuffer(chunk);
    expect(deltas).toEqual(["Hel", "lo"]);
    expect(remainder).toBe("");
  });

  it("keeps incomplete trailing line in remainder", () => {
    const partial = 'data: {"choices":[{"delta":{"content":"Hi';
    const { deltas, remainder } = parseOpenAiSseBuffer(partial);
    expect(deltas).toEqual([]);
    expect(remainder).toBe(partial);
  });
});
