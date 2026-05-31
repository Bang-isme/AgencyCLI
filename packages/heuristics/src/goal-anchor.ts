export interface GoalPillars {
  primaryObjective: string;
  constraints: string[];
  acceptanceCriteria: string[];
}

/**
 * Extracts and compiles the task description into structured Goal Pillars
 * (Primary Objective, Constraints, Acceptance Criteria) to anchor agent attention.
 */
export function compileGoalPillars(task: string): GoalPillars {
  const lines = task.split("\n").map(l => l.trim()).filter(Boolean);
  
  let primaryObjective = "";
  const constraints: string[] = [];
  const acceptanceCriteria: string[] = [];

  // Parse lines to build pillars dynamically
  let currentSection: "objective" | "constraints" | "criteria" = "objective";

  for (const line of lines) {
    const lowerLine = line.toLowerCase();
    
    // Check section boundaries
    if (lowerLine.includes("constraint") || lowerLine.includes("limit") || lowerLine.includes("rule")) {
      currentSection = "constraints";
      continue;
    } else if (lowerLine.includes("acceptance") || lowerLine.includes("criteria") || lowerLine.includes("success") || lowerLine.includes("verify")) {
      currentSection = "criteria";
      continue;
    }

    // Strip markdown list characters
    const cleanLine = line.replace(/^[-*+]\s+/, "").replace(/^\d+\.\s+/, "");

    if (currentSection === "objective") {
      if (!primaryObjective) {
        primaryObjective = cleanLine;
      } else {
        // If there's already an objective, subsequent lines can be constraints or criteria
        if (lowerLine.includes("must") || lowerLine.includes("should") || lowerLine.includes("prevent")) {
          constraints.push(cleanLine);
        } else {
          acceptanceCriteria.push(cleanLine);
        }
      }
    } else if (currentSection === "constraints") {
      constraints.push(cleanLine);
    } else if (currentSection === "criteria") {
      acceptanceCriteria.push(cleanLine);
    }
  }

  // Fallback defaults if empty
  if (!primaryObjective) {
    primaryObjective = task.slice(0, 150) + (task.length > 150 ? "..." : "");
  }
  if (constraints.length === 0) {
    constraints.push("Maintain git state integrity; do not leave workspace in corrupt state.");
    constraints.push("Adhere strictly to typescript compilation and safety rules.");
  }
  if (acceptanceCriteria.length === 0) {
    acceptanceCriteria.push("All unit/integration tests must pass successfully.");
    acceptanceCriteria.push("Project builds completely without compile errors.");
  }

  return { primaryObjective, constraints, acceptanceCriteria };
}

/**
 * Renders the goal anchoring pillars as a highly-visible system prompt block.
 */
export function formatGoalAnchorPrompt(pillars: GoalPillars): string {
  return [
    "=================================================================",
    "⚠️ CRITICAL RUNTIME GOAL ANCHOR (MUST ADHERE TO THROUGHOUT TASK)",
    "=================================================================",
    `🎯 PRIMARY OBJECTIVE:`,
    `   ${pillars.primaryObjective}`,
    ``,
    `🚫 CONSTRAINTS & BOUNDARIES:`,
    ...pillars.constraints.map(c => `   - ${c}`),
    ``,
    `✅ ACCEPTANCE CRITERIA:`,
    ...pillars.acceptanceCriteria.map(a => `   - ${a}`),
    "================================================================="
  ].join("\n");
}
