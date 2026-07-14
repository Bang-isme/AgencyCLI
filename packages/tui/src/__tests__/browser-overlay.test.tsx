import React from "react";
import { describe, expect, it, vi } from "vitest";
import { render } from "ink-testing-library";
import { BrowserOverlay } from "../components/BrowserOverlay.js";
import { THEMES } from "../themes/registry.js";

describe("BrowserOverlay", () => {
  const theme = THEMES.agency!;

  it("renders status and URL input field", () => {
    const { lastFrame } = render(
      <BrowserOverlay
        theme={theme}
        projectRoot="."
        onOpen={() => {}}
        onClose={() => {}}
      />
    );

    expect(lastFrame()).toContain("Browser & Web Tools");
    expect(lastFrame()).toContain("Open Web Page");
    expect(lastFrame()).toContain("https://example.com");
  });

  it("captures typed URL characters and handles backspace", async () => {
    const onOpen = vi.fn();
    const { stdin, lastFrame } = render(
      <BrowserOverlay
        theme={theme}
        projectRoot="."
        onOpen={onOpen}
        onClose={() => {}}
      />
    );

    // Wait for mount
    await new Promise((r) => setTimeout(r, 50));

    // Type characters
    stdin.write("xyzurl");
    await new Promise((r) => setTimeout(r, 50));
    expect(lastFrame()).toContain("xyzurl");

    // Backspace
    stdin.write("\x08");
    await new Promise((r) => setTimeout(r, 50));
    expect(lastFrame()).toContain("xyzur");
    expect(lastFrame()).not.toContain("xyzurl");
  });
});
