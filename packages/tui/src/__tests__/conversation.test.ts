import { describe, expect, it } from "vitest";
import { stripToolCalls, parseAssistantContent } from "../components/Conversation.js";

describe("stripToolCalls", () => {
  it("leaves text without tool calls intact", () => {
    const input = "Hello, this is regular text with no XML tags.";
    expect(stripToolCalls(input)).toBe(input);
  });

  it("strips complete tool calls", () => {
    const input = "Hello\n<tool_call name=\"read_file\">\n  <param name=\"path\">src/App.tsx</param>\n</tool_call>\nWorld";
    expect(stripToolCalls(input)).toBe("Hello\n\nWorld");
  });

  it("strips incomplete tool calls at the end of streaming text", () => {
    const input = "Start\n<tool_call name=\"write_file\">\n  <param name=\"path\">src/index.js</param>\n  <param name=\"content\">con";
    expect(stripToolCalls(input)).toBe("Start\n");
  });

  it("strips multiple tool call blocks mixed with text", () => {
    const input = "One\n<tool_call name=\"t1\">...</tool_call>\nTwo\n<tool_call name=\"t2\">...\n";
    expect(stripToolCalls(input)).toBe("One\n\nTwo\n");
  });

  it("strips mixed invoke and invoke_call tags correctly", () => {
    const input = "One\n<invoke name=\"read_file\">\n  <param name=\"path\">models.py</param>\n</invoke_call>\nTwo\n<invoke_call name=\"read_file\">\n  <param name=\"path\">urls.py</param>\n</tool_call>\nThree";
    expect(stripToolCalls(input)).toBe("One\n\nTwo\n\nThree");
  });

  it("returns empty string for non-string content without throwing", () => {
    // Regression: App patches `content: turn.body || undefined`, and a
    // Partial<SessionMessage> lets `undefined` reach the render-time
    // line-measurement pass. This used to throw "Cannot read properties of
    // undefined (reading 'indexOf')" and crash the whole TUI render loop.
    expect(stripToolCalls(undefined as unknown as string)).toBe("");
    expect(stripToolCalls(null as unknown as string)).toBe("");
    expect(stripToolCalls(42 as unknown as string)).toBe("");
  });

  it("strips minimax:tool_call tags correctly", () => {
    const input = "Start\n<minimax:tool_call name=\"write_file\">\n  <param name=\"path\">src/index.js</param>\n</minimax:tool_call>\nEnd";
    expect(stripToolCalls(input)).toBe("Start\n\nEnd");
  });

  it("strips function_calls wrappers and parameter tags cleanly", () => {
    const input = "Start\n<function_calls><function_call name=\"read_file\"><parameter name=\"path\">src/page.tsx</parameter></function_call></function_calls>\nEnd";
    expect(stripToolCalls(input)).toBe("Start\n\nEnd");
  });

  it("strips stray closing tags left by message continuations", () => {
    const input = "Cập nhật plan:</tool_call></tool_call>";
    expect(stripToolCalls(input)).toBe("Cập nhật plan:");
  });

  it("strips orphan function_calls and param closers leaked by provider wrappers", () => {
    const input = "Giờ update homepage:</function_calls></function_calls></param>\nNext";
    expect(stripToolCalls(input)).toBe("Giờ update homepage:\nNext");
  });

  it("strips malformed function_calls and invoke closers without >", () => {
    const input = "Log:</function_calls\nWait</invoke\nEnd";
    expect(stripToolCalls(input)).toBe("Log:\nWait\nEnd");
  });

  it("collapses repetitive wait narration lines", () => {
    const input = "Build chạy dài.\nĐợi thêm:\nĐợi thêm:\nĐợi:\nXong.";
    expect(stripToolCalls(input)).toBe("Build chạy dài.\nĐợi thêm:\nXong.");
  });

  it("strips function_commands and invoke markup-only lines", () => {
    const input = "Monitor build:\n</function_commands>\n</invoke>\nDone.";
    expect(stripToolCalls(input)).toBe("Monitor build:\n\nDone.");
  });

  it("cleans up minimax tag lookalikes or repetition loop garbage", () => {
    const input = "files:]<]minimax[>[]<]minimax[>[]";
    expect(stripToolCalls(input)).toBe("files:");
  });

  it("strips stray closing tags like </command> and </mm:think>", () => {
    const input = "Finished compile.</command>\n</invoke></mm:think># 🟢 Hello";
    expect(stripToolCalls(input)).toBe("Finished compile.\n# 🟢 Hello");
  });

  it("strips unclosed tags at the end of the string", () => {
    const input = "Next step:<tool_call name=\"x\"";
    expect(stripToolCalls(input)).toBe("Next step:");
  });
});

describe("parseAssistantContent with stripped tool calls", () => {
  it("parses text sections correctly when tool calls are stripped", () => {
    const rawContent = "I will read the file.\n<tool_call name=\"read_file\">\n  <param name=\"path\">src/App.tsx</param>\n</tool_call>\nFile read is done.";
    const cleaned = stripToolCalls(rawContent);
    const blocks = parseAssistantContent(cleaned);
    
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.type).toBe("text");
    expect(blocks[0]?.text?.trim()).toBe("I will read the file.\n\nFile read is done.");
  });
});
