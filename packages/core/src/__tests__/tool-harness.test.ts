import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseToolCalls, executeTool } from "../skill/tool-harness.js";

describe("Tool Harness Subsystem", () => {
  describe("parseToolCalls", () => {
    it("should parse simple XML tool calls", () => {
      const text = `
Here is my decision:
<tool_call name="read_file">
  <path>package.json</path>
</tool_call>
      `;
      const calls = parseToolCalls(text);
      expect(calls).toHaveLength(1);
      expect(calls[0]!.name).toBe("read_file");
      expect(calls[0]!.arguments).toEqual({ path: "package.json" });
    });

    it("should parse XML tool calls with attribute-style param tags and mixed tags (invoke, invoke_call, tool_call)", () => {
      const text = `
<invoke name="read_file">
  <param name="path">cap2-be/app/models.py</param>
</invoke_call>
<invoke_call name="read_file">
  <param name="path">cap2-be/app/urls.py</param>
</tool_call>
<tool_call name="dispatch_subagent">
  <param name="agentId">debugger</param>
  <param name="task">## NHIỆM VỤ: Phân tích</param>
</tool_call>
      `;
      const calls = parseToolCalls(text);
      expect(calls).toHaveLength(3);
      expect(calls[0]!.name).toBe("read_file");
      expect(calls[0]!.arguments).toEqual({ path: "cap2-be/app/models.py" });
      expect(calls[1]!.name).toBe("read_file");
      expect(calls[1]!.arguments).toEqual({ path: "cap2-be/app/urls.py" });
      expect(calls[2]!.name).toBe("dispatch_subagent");
      expect(calls[2]!.arguments).toEqual({
        agentId: "debugger",
        task: "## NHIỆM VỤ: Phân tích",
      });
    });

    it("should parse multiple tool calls with multiline arguments", () => {
      const text = `
<tool_call name="write_file">
  <path>src/index.js</path>
  <content>
    console.log("hello world");
  </content>
</tool_call>
<tool_call name="list_dir">
  <path>.</path>
</tool_call>
      `;
      const calls = parseToolCalls(text);
      expect(calls).toHaveLength(2);
      expect(calls[0]!.name).toBe("write_file");
      expect(calls[0]!.arguments.path).toBe("src/index.js");
      expect(calls[0]!.arguments.content).toContain('console.log("hello world");');
      expect(calls[1]!.name).toBe("list_dir");
      expect(calls[1]!.arguments.path).toBe(".");
    });
  });

  describe("executeTool", () => {
    let tempDir: string;

    beforeEach(() => {
      tempDir = mkdtempSync(join(tmpdir(), "agency-test-"));
    });

    afterEach(() => {
      if (existsSync(tempDir)) {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it("should write and read files successfully", async () => {
      const writeResult = await executeTool(
        "write_file",
        { path: "test.txt", content: "hello tool execution!" },
        tempDir
      );
      expect(writeResult).toContain("Success: File written successfully");

      const readResult = await executeTool(
        "read_file",
        { path: "test.txt" },
        tempDir
      );
      expect(readResult).toBe("File: test.txt (1 lines total, showing 1-1)\n1: hello tool execution!");
    });

    it("should edit file using search-and-replace block", async () => {
      writeFileSync(join(tempDir, "sample.ts"), "const x = 42;\nconst y = 100;", "utf8");

      const editResult = await executeTool(
        "edit_file",
        {
          path: "sample.ts",
          search: "const x = 42;",
          replace: "const x = 9999;",
        },
        tempDir
      );
      expect(editResult).toContain("Success: File edited successfully");

      const content = readFileSync(join(tempDir, "sample.ts"), "utf8");
      expect(content).toBe("const x = 9999;\nconst y = 100;");
    });

    it("should handle error for unknown or invalid tools", async () => {
      const result = await executeTool("super_secret_tool", {}, tempDir);
      expect(result).toContain("Error: Unknown tool");
    });
  });
});
