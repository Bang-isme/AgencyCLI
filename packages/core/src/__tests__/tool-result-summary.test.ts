import { describe, expect, it } from "vitest";
import { summarizeToolResult } from "../chat/stream.js";

// Locks the activity-line tool summaries to the result strings emitted by
// skill/tool-harness.ts (read_file "(N lines total", grep "Found N match(es)",
// execute_command "Exit Code: N", write_file "... N bytes ..."). If a harness
// result format drifts, this fails instead of silently degrading to the fallback.
describe("summarizeToolResult", () => {
  it("read_file / view_file → line count", () => {
    expect(summarizeToolResult("read_file", "File: a.ts (42 lines total, showing 1-42)\n...")).toBe("42 lines");
    expect(summarizeToolResult("view_file", "File: a.ts (1 lines total, showing 1-1)\nx")).toBe("1 line");
    // Fallback to counting when no marker.
    expect(summarizeToolResult("read_file", "line1\nline2\nline3")).toBe("3 lines");
  });

  it("grep tools → match count / no matches", () => {
    expect(summarizeToolResult("grep_search", 'Found 7 match(es) in "src":\na\nb')).toBe("7 matches");
    expect(summarizeToolResult("grep_file", 'Found 1 matches in "a.ts":\nx')).toBe("1 match");
    expect(summarizeToolResult("grep_search", 'No matches found for pattern "x" in "src"')).toBe("no matches");
  });

  it("find_files → file count / no files", () => {
    expect(summarizeToolResult("find_files", "Found 3 files:\na\nb\nc")).toBe("3 files");
    expect(summarizeToolResult("find_files", 'No files found matching pattern "x" in "."')).toBe("no files");
  });

  it("execute_command → exit code", () => {
    expect(summarizeToolResult("execute_command", "Exit Code: 0\nStdout:\nok\nStderr:\n")).toBe("exit 0");
    expect(summarizeToolResult("execute_command", "Exit Code: 1\nStdout:\n\nStderr:\nboom")).toBe("exit 1");
  });

  it("write_file / append_file → human byte size, else 'saved'", () => {
    // The exact strings the harness emits today (kept in lockstep on purpose).
    expect(summarizeToolResult("write_file", 'Success: File written successfully to "a.ts" (2048 bytes)')).toBe("2.0 KB");
    expect(summarizeToolResult("append_file", 'Success: Appended 10 characters to "a.ts"; file now 512 bytes')).toBe("512 B");
    expect(summarizeToolResult("write_file", "Successfully wrote file")).toBe("saved");
  });

  it("list_dir → entry count from the marker (not header + entries)", () => {
    // "Directory: … (N entries)" header + one line per entry. Counting lines
    // would over-count by the header line; the marker is authoritative.
    expect(summarizeToolResult("list_dir", "Directory: src (3 entries)\na.ts\nb.ts\nc.ts")).toBe("3 items");
    expect(summarizeToolResult("list_dir", "Directory: empty (0 entries)\n")).toBe("0 items");
    expect(summarizeToolResult("list_dir", "Directory: one (1 entries)\nonly.ts")).toBe("1 item");
  });

  it("mutating edits → concise verb", () => {
    expect(summarizeToolResult("edit_file", "ok")).toBe("edited");
    expect(summarizeToolResult("delete_file", "ok")).toBe("deleted");
    expect(summarizeToolResult("move_file", "ok")).toBe("moved");
    expect(summarizeToolResult("create_directory", "ok")).toBe("created");
  });

  it("unknown tool → human byte size fallback (never the raw char count phrasing)", () => {
    expect(summarizeToolResult("mystery_tool", "x".repeat(1536))).toBe("1.5 KB");
    expect(summarizeToolResult("mystery_tool", "short")).toBe("5 B");
  });
});
