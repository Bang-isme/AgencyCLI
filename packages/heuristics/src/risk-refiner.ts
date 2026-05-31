import fs from "node:fs";
import path from "node:path";

export interface RiskAdjustments {
  filesystem: number;
  shell: number;
  network: number;
  privilege: number;
  destructive: number;
}

export class RiskHeuristicRefiner {
  private static testAdjustments = new Map<string, RiskAdjustments>();

  private filePath: string;
  private projectRoot: string;
  private isTest = typeof process !== "undefined" && (process.env.NODE_ENV === "test" || process.env.VITEST === "true");

  private adjustments: RiskAdjustments = {
    filesystem: 0.0,
    shell: 0.0,
    network: 0.0,
    privilege: 0.0,
    destructive: 0.0,
  };

  constructor(projectRoot: string) {
    this.projectRoot = projectRoot;
    this.filePath = path.join(projectRoot, ".agency", "risk-weights.json");
    this.loadAdjustments();
  }

  public static clearTestAdjustments(): void {
    RiskHeuristicRefiner.testAdjustments.clear();
  }

  private loadAdjustments(): void {
    if (this.isTest) {
      const existing = RiskHeuristicRefiner.testAdjustments.get(this.projectRoot);
      if (existing) {
        this.adjustments = { ...existing };
      }
      return;
    }

    try {
      if (fs.existsSync(this.filePath)) {
        const data = fs.readFileSync(this.filePath, "utf8");
        const parsed = JSON.parse(data);
        this.adjustments = {
          filesystem: typeof parsed.filesystem === "number" ? parsed.filesystem : 0.0,
          shell: typeof parsed.shell === "number" ? parsed.shell : 0.0,
          network: typeof parsed.network === "number" ? parsed.network : 0.0,
          privilege: typeof parsed.privilege === "number" ? parsed.privilege : 0.0,
          destructive: typeof parsed.destructive === "number" ? parsed.destructive : 0.0,
        };
      }
    } catch {
      // Best-effort loading, fallback to defaults
    }
  }

  private saveAdjustments(): void {
    if (this.isTest) {
      RiskHeuristicRefiner.testAdjustments.set(this.projectRoot, { ...this.adjustments });
      return;
    }

    try {
      const dir = path.dirname(this.filePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(this.filePath, JSON.stringify(this.adjustments, null, 2), "utf8");
    } catch {
      // Best-effort saving
    }
  }

  /**
   * Adjusts risk parameters based on positive or negative overrides.
   * "approve" decreases calculated risk, "deny" increases calculated risk.
   */
  public recordOverride(riskDimension: keyof RiskAdjustments, decision: "approve" | "deny"): void {
    const delta = decision === "approve" ? -0.05 : 0.05;
    const val = this.adjustments[riskDimension] + delta;
    
    // Safety guardrails: adjustments must remain within [-0.3, +0.3]
    this.adjustments[riskDimension] = parseFloat(Math.max(-0.3, Math.min(0.3, val)).toFixed(2));
    this.saveAdjustments();
  }

  public getAdjustments(): RiskAdjustments {
    return { ...this.adjustments };
  }
}
