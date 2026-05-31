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
