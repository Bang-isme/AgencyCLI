import React from "react";
import { describe, expect, it, vi } from "vitest";
import { render } from "ink-testing-library";
import { ThemeOverlay } from "../components/ThemeOverlay.js";
import { THEMES } from "../themes/registry.js";

describe("ThemeOverlay", () => {
  const theme = THEMES.agency!;

  it("renders the list of available themes", () => {
    const { lastFrame } = render(
      <ThemeOverlay
        theme={theme}
        currentThemeId="agency"
        onPreview={() => {}}
        onSelect={() => {}}
        onClose={() => {}}
      />
    );

    expect(lastFrame()).toContain("Theme Selector");
    expect(lastFrame()).toContain("agency");
    expect(lastFrame()).toContain("daylight");
    expect(lastFrame()).toContain("catppuccin");
    expect(lastFrame()).toContain("oneDark");
    expect(lastFrame()).toContain("tokyoNight");
  });

  it("triggers preview callback on arrow keys", async () => {
    const onPreview = vi.fn();
    const { stdin } = render(
      <ThemeOverlay
        theme={theme}
        currentThemeId="agency"
        onPreview={onPreview}
        onSelect={() => {}}
        onClose={() => {}}
      />
    );

    // Wait for mount
    await new Promise((r) => setTimeout(r, 50));

    // Press down arrow
    stdin.write("\u001b[B");
    await new Promise((r) => setTimeout(r, 50));

    expect(onPreview).toHaveBeenCalled();
  });
});
