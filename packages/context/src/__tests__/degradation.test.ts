import { describe, expect, it } from "vitest";
import { degradeCode, degradeWorkspaceContext } from "../degradation.js";

describe("degradeCode", () => {
  it("should collapse basic function bodies", () => {
    const code = `
      function add(a: number, b: number): number {
        return a + b;
      }
    `;
    const result = degradeCode(code);
    expect(result).toContain("function add(a: number, b: number): number { /* collapsed */ }");
  });

  it("should collapse class methods", () => {
    const code = `
      class Calculator {
        constructor() {
          console.log("init");
        }
        add(a: number, b: number): number {
          return a + b;
        }
      }
    `;
    const result = degradeCode(code);
    expect(result).toContain("class Calculator {");
    expect(result).toContain("constructor() { /* collapsed */ }");
    expect(result).toContain("add(a: number, b: number): number { /* collapsed */ }");
  });

  it("should not collapse control flow blocks like if, for, while", () => {
    const code = `
      function process(x: number) {
        if (x > 10) {
          console.log(x);
        }
        for (let i = 0; i < 5; i++) {
          console.log(i);
        }
      }
    `;
    const result = degradeCode(code);
    // Outer function body is collapsed
    expect(result).toContain("function process(x: number) { /* collapsed */ }");

    // Test control flows in non-function contexts directly
    const controlOnly = `
      if (x > 10) {
        console.log(x);
      }
    `;
    expect(degradeCode(controlOnly)).toContain("if (x > 10) {\n        console.log(x);\n      }");
  });

  it("should not get confused by curly braces in strings or comments", () => {
    const code = `
      function test() {
        const str = "brace { in string";
        const comment = // brace { in comment
        /* brace { in block comment */
        return 1;
      }
    `;
    const result = degradeCode(code);
    expect(result).toContain("function test() { /* collapsed */ }");
  });

  it("should not degrade JSON files", () => {
    const json = '{\n  "name": "agency",\n  "version": "1.0.0"\n}';
    expect(degradeCode(json, "package.json")).toBe(json);
  });
});

describe("degradeWorkspaceContext", () => {
  it("should degrade workspace files when they exceed the budget", () => {
    const files = new Map<string, string>();
    files.set("src/index.ts", "export function main() { console.log('hello'); }");
    files.set("src/math.ts", "export function add(a: number, b: number) { return a + b; }");

    // Budget of 70 characters (which is smaller than total size)
    const result = degradeWorkspaceContext(files, 70);
    
    // index.ts should remain intact (Tier 1)
    expect(result.get("src/index.ts")).toBe("export function main() { console.log('hello'); }");
    // math.ts should be degraded (Tier 2)
    expect(result.get("src/math.ts")).toBe("export function add(a: number, b: number) { /* collapsed */ }");
  });
});
