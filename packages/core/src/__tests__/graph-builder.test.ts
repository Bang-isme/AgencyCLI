import { describe, expect, it, vi, afterEach } from "vitest";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildKnowledgeGraph } from "../graph/builder.js";
import { loadSymbolGraph } from "../index/incremental-indexer.js";
import { loadIndex } from "../index/workspace-indexer.js";

vi.mock("node:fs", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs")>();
  return {
    ...original,
    existsSync: vi.fn(),
    readFileSync: vi.fn(),
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn(),
  };
});

vi.mock("../index/workspace-indexer.js", () => ({
  loadIndex: vi.fn(),
}));

vi.mock("../index/incremental-indexer.js", () => ({
  loadSymbolGraph: vi.fn(),
}));

const mockedExistsSync = vi.mocked(existsSync);
const mockedReadFileSync = vi.mocked(readFileSync);
const mockedWriteFileSync = vi.mocked(writeFileSync);
const mockedLoadIndex = vi.mocked(loadIndex);
const mockedLoadSymbolGraph = vi.mocked(loadSymbolGraph);

afterEach(() => {
  vi.clearAllMocks();
});

describe("buildKnowledgeGraph", () => {
  it("compiles class heritage and call edges correctly", async () => {
    const root = "/fake/project";

    mockedLoadIndex.mockReturnValue({
      version: 1,
      root,
      generatedAt: new Date().toISOString(),
      files: [
        { path: "packages/core/src/task/runner.ts", mtimeMs: 100, size: 500 },
        { path: "packages/security/src/process-jail.ts", mtimeMs: 100, size: 500 },
      ],
    });

    mockedLoadSymbolGraph.mockReturnValue({
      version: 1,
      files: {
        "packages/core/src/task/runner.ts": {
          filePath: "packages/core/src/task/runner.ts",
          hash: "abc",
          symbols: [],
          imports: [],
          calls: ["ProcessJail"],
        },
        "packages/security/src/process-jail.ts": {
          filePath: "packages/security/src/process-jail.ts",
          hash: "def",
          symbols: [],
          imports: [],
          exports: ["ProcessJail"],
          heritage: [
            { className: "ProcessJail", parentName: "BaseJail", kind: "extends" },
          ],
        },
      },
    });

    mockedExistsSync.mockReturnValue(true);

    await buildKnowledgeGraph(root);

    expect(mockedWriteFileSync).toHaveBeenCalled();
    const [path, dataStr] = mockedWriteFileSync.mock.calls[0] as [string, string];
    expect(path).toContain("knowledge-graph.json");

    const data = JSON.parse(dataStr);
    expect(data.stats.call_count).toBe(1);
    expect(data.call_edges[0]).toEqual({
      from: "packages/core/src/task/runner.ts",
      to: "packages/security/src/process-jail.ts",
      kind: "call",
      functionName: "ProcessJail",
    });
  });

  it("parses Go/Rust models and Python FastAPI/Flask routes correctly", async () => {
    const root = "/fake/project";

    mockedLoadIndex.mockReturnValue({
      version: 1,
      root,
      generatedAt: new Date().toISOString(),
      files: [
        { path: "app/main.py", mtimeMs: 100, size: 500 },
        { path: "models/user.go", mtimeMs: 100, size: 500 },
        { path: "models/product.rs", mtimeMs: 100, size: 500 },
      ],
    });

    mockedLoadSymbolGraph.mockReturnValue({
      version: 1,
      files: {
        "app/main.py": {
          filePath: "app/main.py",
          hash: "py1",
          symbols: [],
          imports: [],
          semanticFindings: { endpoints: 2, middlewareChecks: 0, labels: [] },
        },
        "models/user.go": {
          filePath: "models/user.go",
          hash: "go1",
          symbols: [],
          imports: [],
        },
        "models/product.rs": {
          filePath: "models/product.rs",
          hash: "rs1",
          symbols: [],
          imports: [],
        },
      },
    });

    mockedExistsSync.mockReturnValue(true);

    mockedReadFileSync.mockImplementation((path: any) => {
      const p = String(path).replace(/\\/g, "/");
      if (p.endsWith("app/main.py")) {
        return `
@app.get("/items")
def get_items():
    pass

@app.route("/login", methods=["POST", "GET"])
def login_handler():
    pass
        `;
      }
      if (p.endsWith("models/user.go")) {
        return `
type User struct {
    ID    int64   \`db:"id"\`
    Name  string  \`db:"name"\`
    Roles []Role  \`db:"roles"\`
}
        `;
      }
      if (p.endsWith("models/product.rs")) {
        return `
pub struct Product {
    pub id: i64,
    pub name: String,
    pub vendor: Option<Vendor>,
    pub tags: Vec<Tag>,
}
        `;
      }
      return "";
    });

    await buildKnowledgeGraph(root);

    expect(mockedWriteFileSync).toHaveBeenCalled();
    const [path, dataStr] = mockedWriteFileSync.mock.calls[0] as [string, string];
    expect(path).toContain("knowledge-graph.json");

    const data = JSON.parse(dataStr);
    
    // Verify Python FastAPI & Flask routes parsed correctly
    expect(data.api_routes).toHaveLength(3);
    expect(data.api_routes).toContainEqual(expect.objectContaining({
      method: "GET",
      path: "/items",
      handler: "get_items",
    }));
    expect(data.api_routes).toContainEqual(expect.objectContaining({
      method: "POST",
      path: "/login",
      handler: "login_handler",
    }));
    expect(data.api_routes).toContainEqual(expect.objectContaining({
      method: "GET",
      path: "/login",
      handler: "login_handler",
    }));

    // Verify Go & Rust models parsed correctly
    expect(data.data_models.User).toBeDefined();
    expect(data.data_models.User.type).toBe("Go Struct");
    expect(data.data_models.User.fields).toContain("ID: int64");
    expect(data.data_models.User.relationships).toContainEqual({
      type: "has_many",
      target: "Role",
      field: "Roles",
    });

    expect(data.data_models.Product).toBeDefined();
    expect(data.data_models.Product.type).toBe("Rust Struct");
    expect(data.data_models.Product.fields).toContain("name: String");
    expect(data.data_models.Product.relationships).toContainEqual({
      type: "belongs_to",
      target: "Vendor",
      field: "vendor",
    });
    expect(data.data_models.Product.relationships).toContainEqual({
      type: "has_many",
      target: "Tag",
      field: "tags",
    });
  });
});
