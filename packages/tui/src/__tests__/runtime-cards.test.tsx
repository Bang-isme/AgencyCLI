import { describe, expect, it } from "vitest";
import { render } from "ink-testing-library";
import { getTheme, DEFAULT_THEME_ID } from "../themes/registry.js";
import { PatchCard } from "../components/PatchCard.js";
import { LogCollapse } from "../components/LogCollapse.js";
import { SEVERITY_GLYPHS } from "../motion/design-system.js";

const theme = getTheme(DEFAULT_THEME_ID);

describe("PatchCard", () => {
  it("renders semantic symbol-level changes and hidden trivial count", () => {
    const { lastFrame } = render(
      <PatchCard
        theme={theme}
        changes={[
          { action: "modify", symbol: "AuthService.login()", file: "src/auth.ts" },
          { action: "add", symbol: "JWT refresh middleware", file: "src/mw.ts" },
        ]}
        hiddenCount={12}
      />
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("AuthService.login()");
    expect(frame).toContain("JWT refresh middleware");
    expect(frame).toContain("12");
  });
});

describe("LogCollapse", () => {
  it("surfaces warnings and errors using the severity vocabulary", () => {
    const { lastFrame } = render(
      <LogCollapse
        theme={theme}
        title="Build"
        entries={[
          { message: "Compiled OK", severity: "info" },
          { message: "Unused import", severity: "warning" },
          { message: "Type error in auth.ts", severity: "error" },
        ]}
      />
    );
    const frame = lastFrame() ?? "";
    // Passing info is hidden; warnings + errors are surfaced.
    expect(frame).toContain("Unused import");
    expect(frame).toContain("Type error in auth.ts");
    expect(frame).toContain(SEVERITY_GLYPHS.warning);
    expect(frame).toContain(SEVERITY_GLYPHS.error);
  });

  it("collapses to a summary when every entry is passing", () => {
    const { lastFrame } = render(
      <LogCollapse
        theme={theme}
        title="Build"
        entries={[
          { message: "step one", severity: "info" },
          { message: "step two", severity: "info" },
        ]}
      />
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("all passing");
    expect(frame).not.toContain("step one");
  });
});
