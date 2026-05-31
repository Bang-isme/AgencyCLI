import { describe, expect, it } from "vitest";
import { LoopDetector } from "../loop-heuristics.js";
import { compileGoalPillars, formatGoalAnchorPrompt } from "../goal-anchor.js";
import { RiskHeuristicRefiner } from "../risk-refiner.js";
import fs from "node:fs";
import path from "node:path";

describe("LoopDetector", () => {
  it("should flag consecutive identical errors", () => {
    const detector = new LoopDetector();
    detector.addError("SyntaxError: Unexpected token");
    expect(detector.detectLoop().loopDetected).toBe(false);

    detector.addError("SyntaxError: Unexpected token");
    expect(detector.detectLoop().loopDetected).toBe(false);

    detector.addError("SyntaxError: Unexpected token");
    const result = detector.detectLoop();
    expect(result.loopDetected).toBe(true);
    expect(result.reason).toContain("identical error loop");
  });

  it("should flag consecutive identical prompts", () => {
    const detector = new LoopDetector();
    detector.addPrompt("fix this issue");
    detector.addPrompt("fix this issue");
    detector.addPrompt("fix this issue");
    const result = detector.detectLoop();
    expect(result.loopDetected).toBe(true);
    expect(result.reason).toContain("Prompt cycle detected");
  });

  it("should flag back-and-forth cyclic file edits", () => {
    const detector = new LoopDetector();
    detector.addPatch("src/index.ts", "const x = 1;");
    detector.addPatch("src/index.ts", "const x = 2;");
    detector.addPatch("src/index.ts", "const x = 1;");
    detector.addPatch("src/index.ts", "const x = 2;");
    const result = detector.detectLoop();
    expect(result.loopDetected).toBe(true);
    expect(result.reason).toContain("Back-and-forth cyclic file edits");
  });
});

describe("GoalAnchor", () => {
  it("should compile tasks into structured pillars", () => {
    const task = `
      Implement a user login feature.
      Constraints:
      - Do not use external CSS packages.
      - Limit max login attempts to 3.
      Acceptance Criteria:
      - Users can enter username and password.
      - Displays error for invalid credentials.
    `;
    const pillars = compileGoalPillars(task);
    expect(pillars.primaryObjective).toContain("Implement a user login feature");
    expect(pillars.constraints).toContain("Do not use external CSS packages.");
    expect(pillars.acceptanceCriteria).toContain("Users can enter username and password.");
  });

  it("should format pillars beautifully", () => {
    const pillars = {
      primaryObjective: "Objective",
      constraints: ["Constraint 1"],
      acceptanceCriteria: ["Criteria 1"]
    };
    const formatted = formatGoalAnchorPrompt(pillars);
    expect(formatted).toContain("⚠️ CRITICAL RUNTIME GOAL ANCHOR");
    expect(formatted).toContain("Objective");
    expect(formatted).toContain("Constraint 1");
    expect(formatted).toContain("Criteria 1");
  });
});

describe("RiskHeuristicRefiner", () => {
  const tmpDir = "./tmp_refiner_test";

  it("should record positive and negative overrides correctly and constrain within safety bounds", () => {
    const refiner = new RiskHeuristicRefiner(tmpDir);

    // Initial adjustments are 0
    expect(refiner.getAdjustments().filesystem).toBe(0);

    // Negative override (deny) increases risk
    refiner.recordOverride("filesystem", "deny");
    expect(refiner.getAdjustments().filesystem).toBe(0.05);

    // Positive override (approve) decreases risk
    refiner.recordOverride("filesystem", "approve");
    expect(refiner.getAdjustments().filesystem).toBe(0);

    // Boundary check [-0.3, +0.3]
    for (let i = 0; i < 10; i++) {
      refiner.recordOverride("shell", "deny");
    }
    expect(refiner.getAdjustments().shell).toBe(0.3); // max limit

    for (let i = 0; i < 15; i++) {
      refiner.recordOverride("shell", "approve");
    }
    expect(refiner.getAdjustments().shell).toBe(-0.3); // min limit

    // Clean up temporary weights adjustments file
    try {
      const filePath = path.join(tmpDir, ".agency", "risk-weights.json");
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
      if (fs.existsSync(path.join(tmpDir, ".agency"))) {
        fs.rmdirSync(path.join(tmpDir, ".agency"));
      }
      if (fs.existsSync(tmpDir)) {
        fs.rmdirSync(tmpDir);
      }
    } catch {}
  });
});
