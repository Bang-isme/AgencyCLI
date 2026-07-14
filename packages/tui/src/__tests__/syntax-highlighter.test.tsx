import React from "react";
import { describe, expect, it } from "vitest";
import { render } from "ink-testing-library";
import { renderHighlightedLine } from "../components/SyntaxHighlighter.js";
import { THEMES } from "../themes/registry.js";
import { Box } from "ink";

describe("TUI Code Syntax Highlighter", () => {
  const theme = THEMES.agency!;

  it("returns plain text for unsupported languages", () => {
    const { lastFrame } = render(
      <Box>{renderHighlightedLine("const a = 123;", "txt", theme)}</Box>
    );
    expect(lastFrame()).toContain("const a = 123;");
  });

  it("tokenizes and highlights JavaScript/TypeScript code correctly", () => {
    const code = "const val = 'hello'; // inline comment";
    const { lastFrame } = render(
      <Box>{renderHighlightedLine(code, "typescript", theme)}</Box>
    );
    
    // Check keyword
    expect(lastFrame()).toContain("const");
    // Check string
    expect(lastFrame()).toContain("'hello'");
    // Check comment
    expect(lastFrame()).toContain("// inline comment");
  });

  it("highlights function calls and numbers", () => {
    const code = "let count = calculate(45);";
    const { lastFrame } = render(
      <Box>{renderHighlightedLine(code, "js", theme)}</Box>
    );

    expect(lastFrame()).toContain("let");
    expect(lastFrame()).toContain("calculate");
    expect(lastFrame()).toContain("45");
  });
});
