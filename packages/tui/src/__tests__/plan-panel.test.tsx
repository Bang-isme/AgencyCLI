import { describe, expect, it } from "vitest";
import { render } from "ink-testing-library";
import { getTheme, DEFAULT_THEME_ID } from "../themes/registry.js";
import { PlanPanel, cleanPlanStep } from "../components/PlanPanel.js";

const theme = getTheme(DEFAULT_THEME_ID);

describe("cleanPlanStep", () => {
  it("strips a leading emoji prefix the model added to the title", () => {
    expect(cleanPlanStep("🎨 Subagent 1: Enhance Color System")).toBe("Subagent 1: Enhance Color System");
    expect(cleanPlanStep("✅ Final build & test verification")).toBe("Final build & test verification");
    expect(cleanPlanStep("🔧 Update globals.css")).toBe("Update globals.css");
    expect(cleanPlanStep("✨ Improve Hero Section")).toBe("Improve Hero Section");
  });

  it("strips a run of multiple leading emoji", () => {
    expect(cleanPlanStep("🎨✨ Title")).toBe("Title");
  });

  it("leaves a plain title untouched", () => {
    expect(cleanPlanStep("Run tests to verify changes")).toBe("Run tests to verify changes");
    expect(cleanPlanStep("Update globals.css with new design tokens")).toBe("Update globals.css with new design tokens");
  });

  it("does not touch emoji in the middle of the title", () => {
    expect(cleanPlanStep("Improve Hero 🎨 Section")).toBe("Improve Hero 🎨 Section");
  });

  it("handles empty / non-string input", () => {
    expect(cleanPlanStep("")).toBe("");
    expect(cleanPlanStep(undefined as unknown as string)).toBe("");
  });
});

describe("PlanPanel", () => {
  it("renders plan titles without the model's leading emoji clutter", () => {
    const { lastFrame } = render(
      <PlanPanel
        theme={theme}
        todos={[
          { step: "🎨 Enhance Color System & Tailwind Theme", status: "in_progress" },
          { step: "✅ Final build & test verification", status: "pending" },
        ]}
      />
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Enhance Color System & Tailwind Theme");
    expect(frame).toContain("Final build & test verification");
    expect(frame).not.toContain("🎨");
    expect(frame).not.toContain("✅");
  });

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

  it("caps rendered rows at maxVisible and anchors on the active step", () => {
    // 6 items, budget of 3 rows: the in-progress step must stay visible and the
    // hidden counts surface — so a long plan can't overflow / clip itself.
    const { lastFrame } = render(
      <PlanPanel
        theme={theme}
        maxVisible={3}
        todos={[
          { step: "step one", status: "completed" },
          { step: "step two", status: "completed" },
          { step: "step three", status: "completed" },
          { step: "step four ACTIVE", status: "in_progress" },
          { step: "step five", status: "pending" },
          { step: "step six", status: "pending" },
        ]}
      />
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("3/6"); // 3 done of 6 total
    expect(frame).toContain("step four ACTIVE"); // active step stays visible
    expect(frame).toContain("done"); // "↑ N done" hidden-above indicator
    expect(frame).toContain("more"); // "↓ N more" hidden-below indicator
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
