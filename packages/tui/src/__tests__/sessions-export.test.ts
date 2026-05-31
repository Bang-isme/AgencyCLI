import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
  createSession,
  exportSessionMarkdown,
  exportSessionToFile,
} from "../sessions/store.js";

const dirs: string[] = [];

afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs.length = 0;
});

describe("session export", () => {
  it("writes markdown export file", () => {
    const root = mkdtempSync(join(tmpdir(), "agency-export-"));
    dirs.push(root);
    const session = createSession(root);
    session.messages.push({
      id: "m2",
      role: "user",
      content: "hello",
      timestamp: Date.now(),
    });

    const path = exportSessionToFile(session);
    const md = readFileSync(path, "utf8");
    expect(md).toContain("hello");
    expect(exportSessionMarkdown(session)).toContain("## You");
  });
});
