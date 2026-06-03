import { describe, expect, it } from "vitest";
import { render } from "ink-testing-library";
import { getTheme, DEFAULT_THEME_ID } from "../themes/registry.js";
import { DisclosureProvider } from "../state/DisclosureProvider.js";
import { RuntimeCard } from "../components/RuntimeCard.js";
import { PatchCard } from "../components/PatchCard.js";
import { LogCollapse } from "../components/LogCollapse.js";
import { ExecutionPanel } from "../components/ExecutionPanel.js";
import { LIFECYCLE_GLYPHS, SEVERITY_GLYPHS } from "../motion/design-system.js";

const theme = getTheme(DEFAULT_THEME_ID);

describe("RuntimeCard", () => {
  it("renders title, meta and findings as a structured card", () => {
    const { lastFrame } = render(
      <RuntimeCard
        theme={theme}
        title="Auth cluster identified"
        tier="primary"
        tag="ACTIVE"
        meta={[{ key: "Endpoints", value: "18" }]}
        findings={["JWT auth detected"]}
      />
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Auth cluster identified");
    expect(frame).toContain("Endpoints");
    expect(frame).toContain("18");
    expect(frame).toContain("JWT auth detected");
  });

  it("shows only the title row when collapsed", () => {
    const { lastFrame } = render(
      <RuntimeCard
        theme={theme}
        title="Background trace"
        findings={["should be hidden"]}
        collapsed
      />
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Background trace");
    expect(frame).not.toContain("should be hidden");
  });
});

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
  it("surfaces warnings and errors using the severity vocabulary in default mode", () => {
    const { lastFrame } = render(
      <DisclosureProvider>
        <LogCollapse
          theme={theme}
          title="Build"
          entries={[
            { message: "Compiled OK", severity: "info" },
            { message: "Unused import", severity: "warning" },
            { message: "Type error in auth.ts", severity: "error" },
          ]}
        />
      </DisclosureProvider>
    );
    const frame = lastFrame() ?? "";
    // Default disclosure hides passing info but shows warning + error.
    expect(frame).toContain("Unused import");
    expect(frame).toContain("Type error in auth.ts");
    expect(frame).toContain(SEVERITY_GLYPHS.warning);
    expect(frame).toContain(SEVERITY_GLYPHS.error);
  });

  it("collapses to a summary when every entry is passing", () => {
    const { lastFrame } = render(
      <DisclosureProvider>
        <LogCollapse
          theme={theme}
          title="Build"
          entries={[
            { message: "step one", severity: "info" },
            { message: "step two", severity: "info" },
          ]}
        />
      </DisclosureProvider>
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("all passing");
    expect(frame).not.toContain("step one");
  });
});

describe("ExecutionPanel", () => {
  it("renders the orchestration tree with the diamond lifecycle vocabulary", () => {
    const { lastFrame } = render(
      <DisclosureProvider>
        <ExecutionPanel theme={theme} thoughts={[]} width={60} phase="writing" />
      </DisclosureProvider>
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Plan");
    expect(frame).toContain("Execute");
    // Phase nodes are drawn from the lifecycle family, not raw ○/✓/→ glyphs.
    expect(frame).toContain(LIFECYCLE_GLYPHS.done); // Plan done
    expect(frame).toContain(LIFECYCLE_GLYPHS.active); // Execute active
  });
});
