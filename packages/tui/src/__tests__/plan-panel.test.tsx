import { describe, expect, it } from "vitest";
import { render } from "ink-testing-library";
import { getTheme, DEFAULT_THEME_ID } from "../themes/registry.js";
import { PlanPanel } from "../components/PlanPanel.js";

const theme = getTheme(DEFAULT_THEME_ID);

describe("PlanPanel", () => {
  it("renders each todo with its own per-item status glyph and a progress count", () => {
    const { lastFrame } = render(
      <PlanPanel
        theme={theme}
        todos={[
          { step: "Research the parser", status: "completed" },
          { step: "Write the fix", status: "in_progress" },
          { step: "Add a test", status: "pending" },
        ]}
      />
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Plan");
    expect(frame).toContain("1/3");
    expect(frame).toContain("Research the parser");
    expect(frame).toContain("Write the fix");
    expect(frame).toContain("Add a test");
    // Distinct glyphs prove the statuses are independent (honest per-item), not a
    // single state replicated across every row.
    expect(frame).toContain("✓"); // completed
    expect(frame).toContain("▶"); // in_progress
    expect(frame).toContain("□"); // pending
  });

  it("renders nothing when there is no active plan", () => {
    const { lastFrame } = render(<PlanPanel theme={theme} todos={[]} />);
    expect((lastFrame() ?? "").trim()).toBe("");
  });

  it("auto-dismisses (renders nothing) once every step is completed", () => {
    // A finished checklist should not linger above the composer after the turn.
    const { lastFrame } = render(
      <PlanPanel
        theme={theme}
        todos={[
          { step: "a", status: "completed" },
          { step: "b", status: "completed" },
        ]}
      />
    );
    expect((lastFrame() ?? "").trim()).toBe("");
  });
});
