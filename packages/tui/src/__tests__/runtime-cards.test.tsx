import { describe, expect, it } from "vitest";
import { render } from "ink-testing-library";
import { getTheme, DEFAULT_THEME_ID } from "../themes/registry.js";
import { PatchCard } from "../components/PatchCard.js";

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
