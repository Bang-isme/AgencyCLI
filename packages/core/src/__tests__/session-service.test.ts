import { describe, expect, it } from "vitest";
import { SessionService, type SessionMessage } from "../session/service.js";

describe("SessionService", () => {
  describe("sanitizeAndRepairSession", () => {
    it("safely closes unclosed tool_call XML tags", () => {
      const messages: SessionMessage[] = [
        {
          id: "1",
          role: "assistant",
          content: "Let me read the file: <tool_call name=\"read_file\"><path>src/index.ts</path>",
          timestamp: Date.now(),
        },
      ];
      const repaired = SessionService.sanitizeAndRepairSession(messages);
      expect(repaired[0].content).toContain("</tool_call>");
    });

    it("appends a synthetic response when a tool call has no response", () => {
      const messages: SessionMessage[] = [
        {
          id: "1",
          role: "assistant",
          content: "Let me read the file: <tool_call name=\"read_file\"><path>src/index.ts</path></tool_call>",
          timestamp: Date.now(),
        },
      ];
      const repaired = SessionService.sanitizeAndRepairSession(messages);
      expect(repaired.length).toBe(2);
      expect(repaired[1].role).toBe("system");
      expect(repaired[1].content).toBe("[SESSION RESUMED: Tool execution interrupted]");
    });

    it("does not append a synthetic response if a tool call is followed by a response", () => {
      const messages: SessionMessage[] = [
        {
          id: "1",
          role: "assistant",
          content: "Let me read the file: <tool_call name=\"read_file\"><path>src/index.ts</path></tool_call>",
          timestamp: Date.now(),
        },
        {
          id: "2",
          role: "system",
          content: "<tool_response>content</tool_response>",
          timestamp: Date.now(),
        },
      ];
      const repaired = SessionService.sanitizeAndRepairSession(messages);
      expect(repaired.length).toBe(2);
      expect(repaired[1].id).toBe("2");
    });
  });

  describe("forkSession", () => {
    it("branches session up to a specific message ID", () => {
      const source = {
        id: "sess-original",
        projectRoot: "/dummy",
        createdAt: 100,
        updatedAt: 200,
        messages: [
          { id: "1", role: "user" as const, content: "hello", timestamp: 110 },
          { id: "2", role: "assistant" as const, content: "hi", timestamp: 120 },
          { id: "3", role: "user" as const, content: "how are you", timestamp: 130 },
        ],
      };
      const forked = SessionService.forkSession(source, "2");
      expect(forked.messages.length).toBe(2);
      expect(forked.messages[0].id).toBe("1");
      expect(forked.messages[1].id).toBe("2");
      expect(forked.id).not.toBe("sess-original");
    });
  });
});
