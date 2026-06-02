import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseToolCalls, executeTool, isFileWritingTool, truncateToolResult, registry, resetToolCircuitBreaker } from "../skill/tool-harness.js";

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

    // §8.8-B — tolerate the malformed wrappers some models (minimax) emit so a
    // recoverable call isn't silently dropped (a dropped call → the model thinks
    // a tool ran that never did → churn/restart-from-scratch).
    it("recovers calls whose closing tag has stray whitespace (</tool_call >, </ tool_call>)", () => {
      const text = `
<tool_call name="read_file">
  <path>a.ts</path>
</tool_call >
<tool_call name="list_dir">
  <path>.</path>
</ tool_call>
      `;
      const calls = parseToolCalls(text);
      expect(calls).toHaveLength(2);
      expect(calls[0]!.name).toBe("read_file");
      expect(calls[0]!.arguments).toEqual({ path: "a.ts" });
      expect(calls[1]!.name).toBe("list_dir");
    });

    it("recovers single-quoted and spaced name attributes", () => {
      const text = `
<tool_call name='read_file' >
  <path>b.ts</path>
</tool_call>
<tool_call name = "list_dir">
  <path>.</path>
</tool_call>
      `;
      const calls = parseToolCalls(text);
      expect(calls).toHaveLength(2);
      expect(calls[0]!.name).toBe("read_file");
      expect(calls[0]!.arguments).toEqual({ path: "b.ts" });
      expect(calls[1]!.name).toBe("list_dir");
    });

    it("does not double-parse when a stray extra closing tag follows a valid call", () => {
      const text = `
<tool_call name="read_file">
  <path>c.ts</path>
</tool_call>
</tool_call>
</invoke>
      `;
      const calls = parseToolCalls(text);
      expect(calls).toHaveLength(1);
      expect(calls[0]!.arguments).toEqual({ path: "c.ts" });
    });

    it("drops (does not crash on) a wrapper with no closing tag — no safe body boundary to recover", () => {
      const text = `
<tool_call name="write_file">
  <path>d.ts</path>
  <content>truncated...
      `;
      expect(() => parseToolCalls(text)).not.toThrow();
      expect(parseToolCalls(text)).toHaveLength(0);
    });
  });

  describe("executeTool", () => {
    let tempDir: string;

    beforeEach(() => {
      tempDir = mkdtempSync(join(tmpdir(), "agency-test-"));
      // Mirror a real turn start: the circuit breaker is a module-level singleton
      // (§8.8) so several consecutive intentional tool failures in a row would
      // otherwise trip it and make later tests get "Circuit breaker triggered".
      resetToolCircuitBreaker();
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

    it("inserts the replacement literally — no $$/$&/$`/$' expansion (edit_file)", async () => {
      writeFileSync(join(tempDir, "code.js"), "const price = OLD;", "utf8");
      // A replacement containing every String.replace special: $$ $& $` $'
      const replacement = "total = $$ + $& + a$`b + $'end";
      const res = await executeTool(
        "edit_file",
        { path: "code.js", search: "OLD", replace: replacement },
        tempDir
      );
      expect(res).toContain("Success");
      // Literal insertion — NOT $$→$, $&→match, etc.
      expect(readFileSync(join(tempDir, "code.js"), "utf8")).toBe("const price = " + replacement + ";");
    });

    it("inserts each replacement literally — no $ pattern expansion (batch_edit)", async () => {
      writeFileSync(join(tempDir, "m.js"), "A\nB", "utf8");
      const repl = "x $$ $& y";
      const res = await executeTool(
        "batch_edit",
        { path: "m.js", edits: JSON.stringify([{ search: "A", replace: repl }]) },
        tempDir
      );
      expect(res).toContain("Success");
      expect(readFileSync(join(tempDir, "m.js"), "utf8")).toBe(repl + "\nB");
    });

    // A failed search/replace used to return a generic "match exactly" message
    // with nothing actionable → the model re-tried the same near-miss → churn.
    // The diagnostic now explains WHY and (for whitespace) echoes the real text.
    it("edit_file diagnoses an indentation-only mismatch and echoes the exact text", async () => {
      writeFileSync(join(tempDir, "f.ts"), "function f() {\n    return x;\n}\n", "utf8");
      const res = await executeTool(
        "edit_file",
        { path: "f.ts", search: "function f() {\n  return x;\n}", replace: "x" }, // 2-space, file has 4
        tempDir
      );
      expect(res).toContain("indentation/whitespace differs");
      expect(res).toContain("line 1");
      expect(res).toContain("    return x;"); // the verbatim 4-space line to copy
    });

    it("edit_file diagnoses a CRLF-vs-LF line-ending mismatch", async () => {
      writeFileSync(join(tempDir, "crlf.txt"), "alpha\r\nbeta\r\ngamma", "utf8");
      const res = await executeTool(
        "edit_file",
        { path: "crlf.txt", search: "alpha\nbeta", replace: "X" },
        tempDir
      );
      expect(res).toContain("CRLF");
    });

    it("edit_file reports a genuinely absent search block", async () => {
      writeFileSync(join(tempDir, "g.txt"), "hello world", "utf8");
      const res = await executeTool(
        "edit_file",
        { path: "g.txt", search: "goodbye", replace: "X" },
        tempDir
      );
      expect(res).toContain("does not appear in the file");
    });

    it("edit_file locates the region by the first matching line", async () => {
      writeFileSync(join(tempDir, "h.txt"), "line A\nline B\nline C", "utf8");
      const res = await executeTool(
        "edit_file",
        { path: "h.txt", search: "line A\nDIFFERENT", replace: "X" },
        tempDir
      );
      expect(res).toContain("first line of the search matches line 1");
    });

    it("batch_edit carries the same diagnostic on a failed edit", async () => {
      writeFileSync(join(tempDir, "b.ts"), "function g() {\n    return y;\n}\n", "utf8");
      const res = await executeTool(
        "batch_edit",
        { path: "b.ts", edits: JSON.stringify([{ search: "function g() {\n  return y;\n}", replace: "x" }]) },
        tempDir
      );
      expect(res).toContain("index 0");
      expect(res).toContain("indentation/whitespace differs");
      // Atomic: nothing written on failure.
      expect(readFileSync(join(tempDir, "b.ts"), "utf8")).toBe("function g() {\n    return y;\n}\n");
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

  // Command output (build/test) puts the verdict — compiler/test errors, the exit
  // summary — at the END. Head-only truncation dropped it, so the model saw a
  // non-zero exit it couldn't explain and churned. The toolResultTailKept flag
  // keeps a head+tail window for command-style results.
  describe("truncateToolResult command-output tail (AGENCY_TOOLRESULT_TAIL)", () => {
    const prev = process.env.AGENCY_TOOLRESULT_TAIL;
    const prevProfile = process.env.AGENCY_PROFILE;
    // Past BOTH caps (> 500 lines AND > 30000 chars — the line path only runs
    // once the char cap is also exceeded) with the real error at the very bottom.
    const longCmd =
      "Exit Code: 1\nStdout:\n" +
      Array.from(
        { length: 3000 },
        (_, i) => `info line ${i} ........................................`
      ).join("\n") +
      "\nStderr:\nFATAL_ERROR_MARKER: build failed at the bottom";
    // > maxChars (30000) on few lines → exercises the char-based path.
    const wideCmd = "Exit Code: 1\nStdout:\n" + "x".repeat(40000) + "\nStderr:\nWIDE_TAIL_MARKER";

    beforeEach(() => {
      delete process.env.AGENCY_PROFILE; // pin legacy so only the explicit flag matters
    });
    afterEach(() => {
      if (prev === undefined) delete process.env.AGENCY_TOOLRESULT_TAIL;
      else process.env.AGENCY_TOOLRESULT_TAIL = prev;
      if (prevProfile === undefined) delete process.env.AGENCY_PROFILE;
      else process.env.AGENCY_PROFILE = prevProfile;
    });

    it("OFF (legacy): drops the trailing errors of a command result (reproduces the bug)", () => {
      delete process.env.AGENCY_TOOLRESULT_TAIL;
      const out = truncateToolResult("execute_command", longCmd);
      expect(out).toContain("Exit Code: 1");
      expect(out).not.toContain("FATAL_ERROR_MARKER");
    });

    it("ON: keeps both the head and the trailing errors (line-based)", () => {
      process.env.AGENCY_TOOLRESULT_TAIL = "1";
      const out = truncateToolResult("execute_command", longCmd);
      expect(out).toContain("Exit Code: 1");
      expect(out).toContain("FATAL_ERROR_MARKER");
      expect(out).toContain("middle lines");
    });

    it("ON: keeps the tail on the char-based path too", () => {
      process.env.AGENCY_TOOLRESULT_TAIL = "1";
      const out = truncateToolResult("execute_command", wideCmd);
      expect(out).toContain("Exit Code: 1");
      expect(out).toContain("WIDE_TAIL_MARKER");
    });

    it("ON: detects a command result by its `Exit Code:` header even under an alias name", () => {
      process.env.AGENCY_TOOLRESULT_TAIL = "1";
      const out = truncateToolResult("run_shell", longCmd);
      expect(out).toContain("FATAL_ERROR_MARKER");
    });

    it("ON: non-command tools (read_file) stay head-only", () => {
      process.env.AGENCY_TOOLRESULT_TAIL = "1";
      const fileLike =
        Array.from(
          { length: 3000 },
          (_, i) => `line ${i} ........................................`
        ).join("\n") + "\nLAST_LINE_MARKER";
      const out = truncateToolResult("read_file", fileLike);
      expect(out).toContain("line 0");
      expect(out).not.toContain("LAST_LINE_MARKER");
    });
  });

  // §8.11-E — the two similarly-named search tools are distinct (single file vs
  // whole workspace); rather than rename them (a name change ripples through the
  // label map / narration / security escalation / recorded traces), the
  // descriptions cross-reference each other so the model picks the right one.
  describe("grep_file vs grep_search clarity (§8.11-E)", () => {
    const desc = (name: string) => registry.listTools().find((t) => t.name === name)?.description ?? "";

    it("grep_file describes a single file and points to grep_search for the workspace", () => {
      const d = desc("grep_file");
      expect(d.toLowerCase()).toContain("single file");
      expect(d).toContain("grep_search");
    });

    it("grep_search describes the whole workspace and points to grep_file for one file", () => {
      const d = desc("grep_search");
      expect(d.toLowerCase()).toContain("workspace");
      expect(d).toContain("grep_file");
    });
  });
});
