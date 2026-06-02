import { describe, expect, it } from "vitest";
import {
  getGroundedTargetName,
  getSemanticToolOperation,
  toPastTense,
} from "../utils/conversation/tool-labels.js";

describe("§8.10-C getGroundedTargetName (no more wrong-label guessing)", () => {
  it("extracts the basename from a plain path string", () => {
    expect(getGroundedTargetName("src/utils/foo.ts")).toBe("foo.ts");
    expect(getGroundedTargetName("a\\b\\bar.css")).toBe("bar.css");
  });

  it("reads recognized path fields from a JSON args blob", () => {
    expect(getGroundedTargetName('{"path":"src/x.ts"}')).toBe("x.ts");
    expect(getGroundedTargetName('{"filePath":"src/y.ts"}')).toBe("y.ts");
    expect(getGroundedTargetName('{"TargetFile":"src/z.ts"}')).toBe("z.ts");
    expect(getGroundedTargetName('{"AbsolutePath":"C:/p/w.ts"}')).toBe("w.ts");
    expect(getGroundedTargetName('{"SearchPath":"src/area"}')).toBe("area");
    expect(getGroundedTargetName('{"DirectoryPath":"src/dir"}')).toBe("dir");
  });

  it("returns a command string verbatim", () => {
    expect(getGroundedTargetName('{"command":"npm run build"}')).toBe("npm run build");
  });

  it("returns NO target (not free-text) when the args carry no path/command field", () => {
    // The bug: a subagent/list_dir call whose first string arg was a task
    // description rendered as the target (`list_dir · short video`). Now it
    // declines to guess rather than mislabel.
    expect(getGroundedTargetName('{"task":"short video","agentId":"researcher"}')).toBe("");
    expect(getGroundedTargetName('{"query":"anything"}')).toBe("");
  });

  it("prefers an explicit path over an also-present free-text field", () => {
    expect(getGroundedTargetName('{"task":"short video","path":"src/real.ts"}')).toBe("real.ts");
  });

  it("returns the real file name — no hardcoded repo-specific descriptions or prefixes", () => {
    // These used to map to "main application runtime container",
    // "LLM chat streaming orchestrator", "TUI component: …" etc. — wrong on a
    // user's own project. Must be the plain basename now.
    expect(getGroundedTargetName("packages/tui/src/App.tsx")).toBe("App.tsx");
    expect(getGroundedTargetName("packages/core/src/chat/stream.ts")).toBe("stream.ts");
    expect(getGroundedTargetName("package.json")).toBe("package.json");
  });
});

describe("getSemanticToolOperation (plain, accurate verbs — no flowery phrasing)", () => {
  it("uses plain verbs with the target file", () => {
    expect(getSemanticToolOperation("read_file", "", "src/page.html")).toBe("Read page.html");
    expect(getSemanticToolOperation("write_file", "", "src/page.html")).toBe("Write page.html");
    expect(getSemanticToolOperation("edit_file", "", "a/b.ts")).toBe("Edit b.ts");
    expect(getSemanticToolOperation("grep_search", "", "src/area")).toBe("Search area");
  });

  it("falls back to a generic but plain label with no target", () => {
    expect(getSemanticToolOperation("read_file", "", "")).toBe("Read file");
    expect(getSemanticToolOperation("execute_command", "", "")).toBe("Run command");
    expect(getSemanticToolOperation("dispatch_subagent", "", "")).toBe("Delegate to subagent");
  });

  it("shows the real command for execute_command (not 'validation suite via …')", () => {
    expect(getSemanticToolOperation("execute_command", '{"command":"npm run build"}')).toBe("Run npm run build");
  });
});

describe("toPastTense", () => {
  it("maps the new action verbs to past tense, leaving the target intact", () => {
    expect(toPastTense("Run npm run build")).toBe("Ran npm run build");
    expect(toPastTense("Write page.html")).toBe("Wrote page.html");
    expect(toPastTense("Read file")).toBe("Read file");
    expect(toPastTense("Append to log.txt")).toBe("Appended to log.txt");
    expect(toPastTense("Delegate to subagent")).toBe("Delegate to subagent"); // unrecognized → unchanged
  });
});
