import { describe, expect, it, vi, afterEach } from "vitest";
import { existsSync, statSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { incrementalUpdateAsync } from "../index/workspace-indexer.js";
import { loadSymbolGraph } from "../index/incremental-indexer.js";

vi.mock("node:fs", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs")>();
  return {
    ...original,
    existsSync: vi.fn(),
    statSync: vi.fn(),
    readFileSync: vi.fn(),
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
  };
});

vi.mock("../index/incremental-indexer.js", () => ({
  loadSymbolGraph: vi.fn(),
}));

const mockedExistsSync = vi.mocked(existsSync);
const mockedStatSync = vi.mocked(statSync);
const mockedReadFileSync = vi.mocked(readFileSync);
const mockedLoadSymbolGraph = vi.mocked(loadSymbolGraph);

afterEach(() => {
  vi.clearAllMocks();
});

describe("Workspace Indexer - Smart Incremental", () => {
  it("only updates specified changed files and their package dependents", async () => {
    const root = "/fake/project";

    mockedExistsSync.mockReturnValue(true);

    mockedReadFileSync.mockImplementation((path: any) => {
      if (typeof path === "string" && (path.endsWith("index.json") || path.endsWith("index.json.tmp"))) {
        return JSON.stringify({
          version: 1,
          root,
          generatedAt: "2026-05-26T00:00:00.000Z",
          files: [
            { path: "src/a.ts", mtimeMs: 10, size: 100, contentHash: "hash-a" },
            { path: "src/b.ts", mtimeMs: 10, size: 100, contentHash: "hash-b" },
            { path: "src/c.ts", mtimeMs: 10, size: 100, contentHash: "hash-c" },
          ],
        });
      }
      return "new file content mock";
    });

    mockedLoadSymbolGraph.mockReturnValue({
      version: 1,
      files: {
        "src/a.ts": {
          filePath: "src/a.ts",
          hash: "hash-a",
          symbols: [],
          imports: [],
        },
        "src/b.ts": {
          filePath: "src/b.ts",
          hash: "hash-b",
          symbols: [],
          imports: [{ name: "foo", module: "src/a.ts" }], // b.ts depends on a.ts
        },
        "src/c.ts": {
          filePath: "src/c.ts",
          hash: "hash-c",
          symbols: [],
          imports: [], // c.ts is independent
        },
      },
    });

    mockedStatSync.mockReturnValue({
      mtimeMs: 20,
      size: 150,
    } as any);

    // a.ts changed!
    const res = await incrementalUpdateAsync(root, {
      changedFiles: ["src/a.ts"],
    });

    // Should update a.ts AND its dependent b.ts, but leave c.ts untouched!
    expect(res).toBeDefined();
    const fileA = res.files.find(f => f.path === "src/a.ts");
    const fileB = res.files.find(f => f.path === "src/b.ts");
    const fileC = res.files.find(f => f.path === "src/c.ts");

    expect(fileA).toBeDefined();
    expect(fileA?.size).toBe(150);
    expect(fileA?.contentHash).not.toBe("hash-a");

    expect(fileB).toBeDefined();
    expect(fileB?.size).toBe(150);
    expect(fileB?.contentHash).not.toBe("hash-b");

    expect(fileC).toBeDefined();
    expect(fileC?.size).toBe(100);
    expect(fileC?.contentHash).toBe("hash-c");
  });
});
