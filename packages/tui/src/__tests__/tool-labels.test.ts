import { describe, expect, it } from "vitest";
import { getGroundedTargetName } from "../utils/conversation/tool-labels.js";

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
});
