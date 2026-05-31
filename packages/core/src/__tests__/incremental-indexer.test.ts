import { describe, expect, it, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  extractSymbolsAndImports,
  loadSymbolGraph,
  updateFileInSymbolGraph,
} from "../index/incremental-indexer.js";

describe("Incremental Indexer Subsystem", () => {
  const tmpDirs: string[] = [];

  function makeTmpRoot(): string {
    const dir = mkdtempSync(join(tmpdir(), "agency-indexer-test-"));
    tmpDirs.push(dir);
    return dir;
  }

  afterEach(() => {
    for (const dir of tmpDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("should extract functions, classes, methods, and imports from TS/JS code", () => {
    const code = `
import { api } from "./api.js";
import defaultVal, { otherVal as renamed } from "node:fs";

export class Calculator {
  public add(a: number, b: number): number {
    return a + b;
  }
}

export function compute(x: number) {
  return x * 2;
}

export interface Metric {
  value: number;
}
    `.trim();

    const data = extractSymbolsAndImports(code, "calculator.ts");

    // Verify imports
    expect(data.imports).toContainEqual({ name: "api", module: "./api.js" });
    expect(data.imports).toContainEqual({ name: "defaultVal", module: "node:fs" });
    expect(data.imports).toContainEqual({ name: "renamed", module: "node:fs" });

    // Verify classes, methods, functions
    expect(data.symbols).toContainEqual(expect.objectContaining({ name: "Calculator", kind: "class" }));
    expect(data.symbols).toContainEqual(expect.objectContaining({ name: "add", kind: "method", className: "Calculator" }));
    expect(data.symbols).toContainEqual(expect.objectContaining({ name: "compute", kind: "function" }));
    expect(data.symbols).toContainEqual(expect.objectContaining({ name: "Metric", kind: "interface" }));
  });

  it("should incrementally load, update, and persist symbol graph", () => {
    const root = makeTmpRoot();
    
    // First load (empty)
    const initialGraph = loadSymbolGraph(root);
    expect(initialGraph.files).toEqual({});

    // Update with file
    const code = `function calculate() { return 100; }`;
    const graphAfterUpdate = updateFileInSymbolGraph(root, "math.ts", code);

    expect(graphAfterUpdate.files["math.ts"]).toBeDefined();
    expect(graphAfterUpdate.files["math.ts"].symbols[0].name).toBe("calculate");

    // Load from disk
    const loadedGraph = loadSymbolGraph(root);
    expect(loadedGraph.files["math.ts"]).toBeDefined();
    expect(loadedGraph.files["math.ts"].symbols[0].name).toBe("calculate");
  });
});
