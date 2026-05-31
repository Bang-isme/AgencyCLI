import { describe, it, expect } from "vitest";
import { parseFileEditSuggestions } from "@agency/core";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";

describe("parseFileEditSuggestions", () => {
  it("parses file path from preceding header line", () => {
    const text = `
Here is the code to write:
### File: src/components/Header.tsx
\`\`\`typescript
export function Header() {
  return <h1>Hello</h1>;
}
\`\`\`
    `;
    const result = parseFileEditSuggestions(text);
    expect(result).toHaveLength(1);
    expect(result[0].filePath).toBe("src/components/Header.tsx");
    expect(result[0].content).toContain("export function Header()");
  });

  it("parses file path from **File:** bold preceding header line", () => {
    const text = `
**File:** \`src/index.ts\`
\`\`\`typescript
export * from "./main.js";
\`\`\`
    `;
    const result = parseFileEditSuggestions(text);
    expect(result).toHaveLength(1);
    expect(result[0].filePath).toBe("src/index.ts");
    expect(result[0].content).toBe('export * from "./main.js";');
  });

  it("parses file path from language specifier with colon", () => {
    const text = `
\`\`\`typescript:src/utils.ts
export const add = (a: number, b: number) => a + b;
\`\`\`
    `;
    const result = parseFileEditSuggestions(text);
    expect(result).toHaveLength(1);
    expect(result[0].filePath).toBe("src/utils.ts");
    expect(result[0].content).toBe("export const add = (a: number, b: number) => a + b;");
  });

  it("parses file path from language specifier with space", () => {
    const text = `
\`\`\`typescript src/math.ts
export const square = (n: number) => n * n;
\`\`\`
    `;
    const result = parseFileEditSuggestions(text);
    expect(result).toHaveLength(1);
    expect(result[0].filePath).toBe("src/math.ts");
  });

  it("parses file path from language specifier with parentheses", () => {
    const text = `
\`\`\`typescript (src/config.json)
{
  "theme": "dark"
}
\`\`\`
    `;
    const result = parseFileEditSuggestions(text);
    expect(result).toHaveLength(1);
    expect(result[0].filePath).toBe("src/config.json");
  });

  it("parses file path from first line comment inside the block", () => {
    const text = `
\`\`\`typescript
// path: src/api.ts
export function fetchUser() {}
\`\`\`
    `;
    const result = parseFileEditSuggestions(text);
    expect(result).toHaveLength(1);
    expect(result[0].filePath).toBe("src/api.ts");
    expect(result[0].content).toBe("export function fetchUser() {}");
  });

  it("parses file path from hash comments inside the block", () => {
    const text = `
\`\`\`python
# filepath: scripts/test.py
print("running tests")
\`\`\`
    `;
    const result = parseFileEditSuggestions(text);
    expect(result).toHaveLength(1);
    expect(result[0].filePath).toBe("scripts/test.py");
    expect(result[0].content).toBe('print("running tests")');
  });

  it("ignores dummy and placeholder paths", () => {
    const text = `
### File: path/to/file.ts
\`\`\`typescript
console.log("hello");
\`\`\`

**File:** example.ts
\`\`\`typescript
console.log("world");
\`\`\`
    `;
    const result = parseFileEditSuggestions(text);
    expect(result).toHaveLength(0);
  });

  it("applies search/replace blocks correctly", () => {
    const root = mkdtempSync(join(tmpdir(), "agency-parser-"));
    const filePath = "src/components/Header.tsx";
    const fullPath = join(root, filePath);
    mkdirSync(dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, "const a = 1;\nconst b = 2;\n", "utf8");

    const text = `
Modify ${filePath}:
<<<<<<< SEARCH
const a = 1;
=======
const a = 100;
>>>>>>> REPLACE
`;
    const result = parseFileEditSuggestions(text, root);
    expect(result).toHaveLength(1);
    expect(result[0].filePath).toBe(filePath);
    expect(result[0].content).toBe("const a = 100;\nconst b = 2;\n");

    rmSync(root, { recursive: true, force: true });
  });

  it("handles multiple search/replace blocks in the same file", () => {
    const root = mkdtempSync(join(tmpdir(), "agency-parser-"));
    const filePath = "src/utils.ts";
    const fullPath = join(root, filePath);
    mkdirSync(dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, "const a = 1;\nconst b = 2;\nconst c = 3;\n", "utf8");

    const text = `
Modify ${filePath}:
<<<<<<< SEARCH
const a = 1;
=======
const a = 10;
>>>>>>> REPLACE

Modify ${filePath} again:
<<<<<<< SEARCH
const c = 3;
=======
const c = 30;
>>>>>>> REPLACE
`;
    const result = parseFileEditSuggestions(text, root);
    expect(result).toHaveLength(1);
    expect(result[0].filePath).toBe(filePath);
    expect(result[0].content).toBe("const a = 10;\nconst b = 2;\nconst c = 30;\n");

    rmSync(root, { recursive: true, force: true });
  });

  it("handles search/replace with path in SEARCH header", () => {
    const root = mkdtempSync(join(tmpdir(), "agency-parser-"));
    const filePath = "src/main.ts";
    const fullPath = join(root, filePath);
    mkdirSync(dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, "console.log('original');\n", "utf8");

    const text = `
<<<<<<< SEARCH:${filePath}
console.log('original');
=======
console.log('replaced');
>>>>>>> REPLACE
`;
    const result = parseFileEditSuggestions(text, root);
    expect(result).toHaveLength(1);
    expect(result[0].filePath).toBe(filePath);
    expect(result[0].content).toBe("console.log('replaced');\n");

    rmSync(root, { recursive: true, force: true });
  });
});

