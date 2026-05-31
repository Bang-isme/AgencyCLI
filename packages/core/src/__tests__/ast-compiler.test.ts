import { describe, expect, it } from "vitest";
import {
  replaceFunctionBody,
  replaceMethodBody,
  insertFunction,
  renameSymbol,
  modifyImport,
  deleteNode,
  applyPatch,
} from "../utils/ast-compiler.js";

describe("AST Compiler Subsystem", () => {
  it("should replace function body correctly by exact name", () => {
    const code = `
function hello(name: string): string {
  return "hello " + name;
}
export function other() {
  return 123;
}
    `.trim();

    const result = replaceFunctionBody(code, "hello", `return "hi " + name;`);
    expect(result).toContain(`function hello(name: string): string {\n  return "hi " + name;\n}`);
    expect(result).toContain("export function other()");
  });

  it("should replace class method body correctly by exact name", () => {
    const code = `
class MathHelper {
  public add(a: number, b: number): number {
    return a + b;
  }
  public sub(a: number, b: number): number {
    return a - b;
  }
}
    `.trim();

    const result = replaceMethodBody(code, "MathHelper", "sub", "return b - a;");
    expect(result).toContain("public add");
    expect(result).toContain(`public sub(a: number, b: number): number {\n  return b - a;\n}`);
  });

  it("should insert a new function block to the end of the file", () => {
    const code = `const val = 1;`;
    const result = insertFunction(code, `function test() { return val; }`);
    expect(result).toBe(`const val = 1;\n\nfunction test() { return val; }\n`);
  });

  it("should rename symbols correctly", () => {
    const code = `
const x = 10;
console.log(x);
    `.trim();
    const result = renameSymbol(code, "x", "y");
    expect(result).toContain("const y = 10;");
    expect(result).toContain("console.log(y);");
  });

  it("should modify import declarations correctly", () => {
    const code = `
import { foo, bar } from "my-module";
import { other } from "other-module";
    `.trim();

    // Add named import
    const result1 = modifyImport(code, "my-module", ["baz"]);
    expect(result1).toContain(`import { foo, bar, baz } from "my-module";`);

    // Remove named import
    const result2 = modifyImport(code, "my-module", [], ["foo"]);
    expect(result2).toContain(`import { bar } from "my-module";`);

    // Add new module import when missing
    const result3 = modifyImport(code, "new-module", ["hello"]);
    expect(result3).toContain(`import { hello } from "new-module";`);
  });

  it("should delete function, class, or variable declarations", () => {
    const code = `
export function keepThis() { return 1; }
export function deleteThis() { return 2; }
    `.trim();
    const result = deleteNode(code, "deleteThis");
    expect(result).toContain("export function keepThis()");
    expect(result).not.toContain("export function deleteThis()");
  });

  it("should apply PatchOperation correctly", () => {
    const code = `
function test() {
  return 0;
}
    `.trim();
    const result = applyPatch(code, {
      type: "ReplaceMethodBody", // fallback to function since className undefined
      filePath: "test.ts",
      targetName: "test",
      replacementContent: "return 42;",
    });
    expect(result).toContain("return 42;");
  });
});
