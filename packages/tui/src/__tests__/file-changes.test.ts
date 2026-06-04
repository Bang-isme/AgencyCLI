import { describe, expect, it } from "vitest";
import { extractFileChanges } from "../components/Conversation.js";

describe("extractFileChanges (per-message file-change summary)", () => {
  it("reads write/edit/delete/move tool calls into honest verb + path rows", () => {
    const content = [
      "I'll make the changes.",
      '<tool_call name="edit_file"><param name="path">src/auth.ts</param><param name="search">a</param><param name="replace">b</param></tool_call>',
      '<tool_call name="write_file"><param name="path">src/mw.ts</param><param name="content">x</param></tool_call>',
      '<tool_call name="delete_file"><param name="path">src/old.ts</param></tool_call>',
      '<tool_call name="move_file"><param name="source">a.ts</param><param name="destination">b.ts</param></tool_call>',
    ].join("\n");
    expect(extractFileChanges(content)).toEqual([
      { verb: "edit", path: "src/auth.ts" },
      { verb: "write", path: "src/mw.ts" },
      { verb: "delete", path: "src/old.ts" },
      { verb: "rename", path: "a.ts → b.ts" },
    ]);
  });

  it("ignores read-only tools and dedupes repeated (verb, path)", () => {
    const content = [
      '<tool_call name="read_file"><param name="path">src/auth.ts</param></tool_call>',
      '<tool_call name="grep_search"><param name="pattern">TODO</param></tool_call>',
      '<tool_call name="edit_file"><param name="path">src/auth.ts</param><param name="search">a</param><param name="replace">b</param></tool_call>',
      '<tool_call name="edit_file"><param name="path">src/auth.ts</param><param name="search">c</param><param name="replace">d</param></tool_call>',
    ].join("\n");
    expect(extractFileChanges(content)).toEqual([{ verb: "edit", path: "src/auth.ts" }]);
  });

  it("returns [] for plain prose with no tool calls", () => {
    expect(extractFileChanges("Just explaining the approach, no edits yet.")).toEqual([]);
    expect(extractFileChanges("")).toEqual([]);
  });
});
