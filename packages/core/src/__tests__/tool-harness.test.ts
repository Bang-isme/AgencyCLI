import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseToolCalls, executeTool, isFileWritingTool, truncateToolResult } from "../skill/tool-harness.js";

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

    it("ast_edit renames a symbol across the file via the AST", async () => {
      writeFileSync(join(tempDir, "rename.ts"), "const foo = 1;\nconsole.log(foo + foo);", "utf8");
      const res = await executeTool(
        "ast_edit",
        { path: "rename.ts", operation: "rename_symbol", target: "foo", replacement: "bar" },
        tempDir
      );
      expect(res).toContain("Success: ast_edit (rename_symbol)");
      expect(readFileSync(join(tempDir, "rename.ts"), "utf8")).toBe(
        "const bar = 1;\nconsole.log(bar + bar);"
      );
    });

    it("ast_edit replaces a function body via the AST", async () => {
      writeFileSync(join(tempDir, "fn.ts"), "function add(a, b) {\n  return a - b;\n}", "utf8");
      const res = await executeTool(
        "ast_edit",
        { path: "fn.ts", operation: "replace_function_body", target: "add", replacement: "return a + b;" },
        tempDir
      );
      expect(res).toContain("Success: ast_edit (replace_function_body)");
      const content = readFileSync(join(tempDir, "fn.ts"), "utf8");
      expect(content).toContain("return a + b;");
      expect(content).not.toContain("a - b");
    });

    it("ast_edit returns a clear error on missing operation args", async () => {
      writeFileSync(join(tempDir, "x.ts"), "const a = 1;", "utf8");
      const res = await executeTool(
        "ast_edit",
        { path: "x.ts", operation: "rename_symbol", target: "a" }, // missing replacement
        tempDir
      );
      expect(res).toContain("Error: rename_symbol needs");
    });

    it("ast_edit errors when the target file is missing", async () => {
      const res = await executeTool(
        "ast_edit",
        { path: "nope.ts", operation: "delete_node", target: "x" },
        tempDir
      );
      expect(res).toContain("Error: File not found");
    });

    it("append_file builds a large file incrementally (write first chunk, then append)", async () => {
      // This is the supported path for a file too big for one write_file call —
      // the model splits it into chunks instead of resorting to shell escaping.
      const first = await executeTool("write_file", { path: "big.html", content: "<html>\n" }, tempDir);
      expect(first).toContain("Success: File written successfully");

      const second = await executeTool("append_file", { path: "big.html", content: "<body>part2</body>\n" }, tempDir);
      expect(second).toContain("Success: Appended");
      expect(second).not.toContain("(created)"); // already existed

      const third = await executeTool("append_file", { path: "big.html", content: "</html>\n" }, tempDir);
      expect(third).toContain("Success: Appended");

      expect(readFileSync(join(tempDir, "big.html"), "utf8")).toBe(
        "<html>\n<body>part2</body>\n</html>\n"
      );
    });

    it("append_file creates the file when it does not yet exist", async () => {
      const res = await executeTool("append_file", { path: "fresh.txt", content: "line1\n" }, tempDir);
      expect(res).toContain("Success: Appended");
      expect(res).toContain("(created)");
      expect(readFileSync(join(tempDir, "fresh.txt"), "utf8")).toBe("line1\n");
    });

    it("append_file requires a path (rejected by schema validation)", async () => {
      const res = await executeTool("append_file", { content: "x" }, tempDir);
      expect(res).toContain("Error");
      expect(res).toContain("path");
    });
  });

  describe("isFileWritingTool", () => {
    it("flags content-writing tools (incl. ast_edit + append_file), not read-only ones", () => {
      expect(isFileWritingTool("write_file")).toBe(true);
      expect(isFileWritingTool("append_file")).toBe(true);
      expect(isFileWritingTool("edit_file")).toBe(true);
      expect(isFileWritingTool("ast_edit")).toBe(true);
      expect(isFileWritingTool("read_file")).toBe(false);
      expect(isFileWritingTool("list_dir")).toBe(false);
    });
  });

  describe("truncateToolResult model-aware scaling", () => {
    const huge = "x".repeat(500_000); // single long line, no newlines

    it("actually scales by the model's context window (regression: require() was dead in ESM)", () => {
      // The old `require("@agency/providers")` threw in this ESM module and was
      // swallowed, so EVERY model fell back to the same default — a small-context
      // model was handed the full result and could overflow. These must differ.
      const small = truncateToolResult("read_file", huge, "gpt-3.5-turbo"); // ~16K ctx
      const large = truncateToolResult("read_file", huge, "claude-opus-4-5"); // ~200K ctx
      expect(small.length).toBeLessThan(large.length);
    });

    it("caps a small-context model aggressively (overflow protection)", () => {
      const small = truncateToolResult("read_file", huge, "gpt-3.5-turbo");
      // 8K-char cap + a short truncation note — far below the ~30K default.
      expect(small.length).toBeLessThan(9000);
      expect(small).toContain("truncated");
    });

    it("does NOT dump a huge result even on a large-context model (token efficiency)", () => {
      const large = truncateToolResult("read_file", huge, "claude-opus-4-5");
      // Lean cap, nowhere near the old 400K-char (~100K token) dump.
      expect(large.length).toBeLessThan(60000);
    });

    it("returns short results unchanged", () => {
      const short = "all good";
      expect(truncateToolResult("read_file", short, "claude-opus-4-5")).toBe(short);
    });
  });
});
