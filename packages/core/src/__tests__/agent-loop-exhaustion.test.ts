import { describe, expect, it } from "vitest";
import { exhaustedToolLoop } from "../agents/orchestrator.js";

describe("subagent loop exhaustion", () => {
  it("marks the durable loop-limit notice as incomplete", () => {
    expect(exhaustedToolLoop(
      "Work so far\n[SYSTEM: Reached the maximum 30 tool/continuation iterations for this turn]"
    )).toBe(true);
  });

  it("does not misclassify a normal completed response", () => {
    expect(exhaustedToolLoop("Implemented the change and the targeted tests pass.")).toBe(false);
  });
});
