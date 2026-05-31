import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildAtReferenceContext,
  fuzzySearchFiles,
  parseAtReferences,
  resolveAllFileReferences,
} from "../context/file-refs.js";
import { writeIndex, buildIndex } from "../index/workspace-indexer.js";

const dirs: string[] = [];

afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs.length = 0;
});

describe("file-refs", () => {
  it("parseAtReferences extracts paths", () => {
    expect(parseAtReferences("see @src/a.ts and @README.md")).toEqual([
      "src/a.ts",
      "README.md",
    ]);
  });

  it("fuzzySearchFiles ranks by substring", () => {
    const root = mkdtempSync(join(tmpdir(), "agency-at-"));
    dirs.push(root);
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "auth.ts"), "x", "utf8");
    writeFileSync(join(root, "README.md"), "y", "utf8");
    writeIndex(root, buildIndex(root));

    const hits = fuzzySearchFiles(root, "auth", 5);
    expect(hits[0]).toBe("src/auth.ts");
  });

  it("buildAtReferenceContext reads file bodies", () => {
    const root = mkdtempSync(join(tmpdir(), "agency-at-"));
    dirs.push(root);
    writeFileSync(join(root, "note.txt"), "hello", "utf8");
    const { block, resolved, missing } = buildAtReferenceContext(root, [
      "note.txt",
      "nope.txt",
    ]);
    expect(resolved).toContain("note.txt");
    expect(missing).toContain("nope.txt");
    expect(block).toContain("hello");
  });

  it("resolveAllFileReferences resolves explicit and implicit paths", () => {
    const root = mkdtempSync(join(tmpdir(), "agency-at-implicit-"));
    dirs.push(root);
    mkdirSync(join(root, "packages", "tui", "src"), { recursive: true });
    writeFileSync(join(root, "packages", "tui", "src", "App.tsx"), "content", "utf8");
    writeFileSync(join(root, "package.json"), "{}", "utf8");
    writeFileSync(join(root, "README.md"), "# README", "utf8");
    writeIndex(root, buildIndex(root));

    // 1. Explicit reference
    const refs1 = resolveAllFileReferences("check @packages/tui/src/App.tsx", root);
    expect(refs1).toEqual(["packages/tui/src/App.tsx"]);

    // 2. Implicit relative path (exists exactly)
    const refs2 = resolveAllFileReferences("read packages/tui/src/App.tsx", root);
    expect(refs2).toEqual(["packages/tui/src/App.tsx"]);

    // 3. Suffix match from index
    const refs3 = resolveAllFileReferences("please check tui/src/App.tsx", root);
    expect(refs3).toEqual(["packages/tui/src/App.tsx"]);

    // 4. Filename match from index
    const refs4 = resolveAllFileReferences("what is inside App.tsx and package.json?", root);
    expect(refs4).toContain("packages/tui/src/App.tsx");
    expect(refs4).toContain("package.json");

    // 5. Filename match without extension (case-insensitive) from index
    const refs5 = resolveAllFileReferences("read readme and packages/tui/src/App", root);
    expect(refs5).toContain("README.md");
    expect(refs5).toContain("packages/tui/src/App.tsx");

    // 6. Read intent with Vietnamese and English patterns
    const refs6 = resolveAllFileReferences("hãy đọc file App.tsx và xem file:package.json", root);
    expect(refs6).toContain("packages/tui/src/App.tsx");
    expect(refs6).toContain("package.json");

    const refs7 = resolveAllFileReferences("read package.json and show packages/tui/src/App", root);
    expect(refs7).toContain("package.json");
    expect(refs7).toContain("packages/tui/src/App.tsx");
  });
});

