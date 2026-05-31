import { existsSync } from "node:fs";
import { join } from "node:path";

export type ContextTier = 0 | 1 | 2 | 3 | 4;

export interface ContextProjectionScore {
  topologyCoverage: number;       // 0.0 to 1.0
  taskCoverage: number;           // 0.0 to 1.0
  verificationCoverage: number;   // 0.0 to 1.0
  recoveryCoverage: number;       // 0.0 to 1.0
  tokenCost: number;              // Raw token/byte usage
  operationalDensity: number;     // Ratio of signal-to-noise
}

export interface SkillArtifact {
  id: string;
  type: "template" | "script" | "reference" | "workflow";
  content: string;
  dependsOn?: string[];
  priorityClass: "critical" | "high" | "medium" | "low";
  phase: "planning" | "implementation" | "verification" | "recovery";
}

export interface ProjectEcosystem {
  isMonorepo: boolean;
  packageManager: "pnpm" | "npm" | "yarn";
  framework: "nextjs" | "vite" | "express" | "none";
  styling: "tailwind" | "vanilla" | "none";
  routingMode: "app-router" | "pages-router" | "none";
  orm: "prisma" | "none";
}

export interface ProjectionState {
  currentTier: ContextTier;
  activeArtifacts: string[];
  escalationHistory: string[];
  tokenCost: number;
}

// ==========================================
// 1. CONTEXT SUFFICIENCY MODEL
// ==========================================
export class ContextSufficiencyModel {
  public static calculateScore(
    topologyCoverage: number,
    taskCoverage: number,
    verificationCoverage: number,
    recoveryCoverage: number,
    tokenCost: number,
    budgetCeiling: number
  ): ContextProjectionScore {
    const signal = topologyCoverage + taskCoverage + verificationCoverage + recoveryCoverage;
    const noise = tokenCost > budgetCeiling ? (tokenCost - budgetCeiling) / budgetCeiling : 0;
    const density = signal / (1.0 + noise);

    return {
      topologyCoverage,
      taskCoverage,
      verificationCoverage,
      recoveryCoverage,
      tokenCost,
      operationalDensity: Math.max(0, Math.min(1.0, density))
    };
  }

  public static isSufficient(score: ContextProjectionScore, phase?: string): boolean {
    const threshold = 0.75;
    let wTopology = 0.4;
    let wTask = 0.3;
    let wVerification = 0.2;
    let wRecovery = 0.1;

    if (phase === "planning") {
      wTopology = 0.6;
      wTask = 0.3;
      wVerification = 0.1;
      wRecovery = 0.0;
    } else if (phase === "verification") {
      wTopology = 0.2;
      wTask = 0.2;
      wVerification = 0.5;
      wRecovery = 0.1;
    } else if (phase === "recovery") {
      wTopology = 0.1;
      wTask = 0.1;
      wVerification = 0.2;
      wRecovery = 0.6;
    }

    const weightedSum =
      wTopology * score.topologyCoverage +
      wTask * score.taskCoverage +
      wVerification * score.verificationCoverage +
      wRecovery * score.recoveryCoverage;

    return weightedSum >= threshold && score.tokenCost <= 10000;
  }
}

// ==========================================
// 2. PROJECT TOPOLOGY DETECTION
// ==========================================
export class TopologyDetector {
  private cache = new Map<string, ProjectEcosystem>();

  public detectEcosystem(projectRoot: string): ProjectEcosystem {
    const cached = this.cache.get(projectRoot);
    if (cached) return cached;

    const ecosystem: ProjectEcosystem = {
      isMonorepo: false,
      packageManager: "npm",
      framework: "none",
      styling: "none",
      routingMode: "none",
      orm: "none"
    };

    try {
      if (existsSync(join(projectRoot, "pnpm-workspace.yaml"))) {
        ecosystem.isMonorepo = true;
        ecosystem.packageManager = "pnpm";
      } else if (existsSync(join(projectRoot, "yarn.lock"))) {
        ecosystem.packageManager = "yarn";
      } else if (existsSync(join(projectRoot, "pnpm-lock.yaml"))) {
        ecosystem.packageManager = "pnpm";
      }

      if (existsSync(join(projectRoot, "next.config.js")) || existsSync(join(projectRoot, "next.config.mjs"))) {
        ecosystem.framework = "nextjs";
        ecosystem.routingMode = "app-router"; // default Next.js stack bias
        if (existsSync(join(projectRoot, "pages")) && !existsSync(join(projectRoot, "app"))) {
          ecosystem.routingMode = "pages-router";
        }
      } else if (existsSync(join(projectRoot, "vite.config.ts")) || existsSync(join(projectRoot, "vite.config.js"))) {
        ecosystem.framework = "vite";
      }

      if (existsSync(join(projectRoot, "tailwind.config.js")) || existsSync(join(projectRoot, "tailwind.config.ts"))) {
        ecosystem.styling = "tailwind";
      }

      if (existsSync(join(projectRoot, "prisma")) || existsSync(join(projectRoot, "prisma/schema.prisma"))) {
        ecosystem.orm = "prisma";
      }
    } catch {
      // safe fallback on read errors
    }

    this.cache.set(projectRoot, ecosystem);
    return ecosystem;
  }

  public clearCache(): void {
    this.cache.clear();
  }
}

// ==========================================
// 3. ARTIFACT DEPENDENCY GRAPH RESOLVER
// ==========================================
export class ArtifactDependencyGraphResolver {
  public static resolve(artifacts: SkillArtifact[]): SkillArtifact[] {
    const adj = new Map<string, string[]>();
    const inDegree = new Map<string, number>();
    const nodeMap = new Map<string, SkillArtifact>();

    for (const art of artifacts) {
      nodeMap.set(art.id, art);
      inDegree.set(art.id, 0);
      adj.set(art.id, []);
    }

    for (const art of artifacts) {
      if (art.dependsOn) {
        for (const depId of art.dependsOn) {
          if (inDegree.has(depId)) {
            adj.get(depId)!.push(art.id);
            inDegree.set(art.id, inDegree.get(art.id)! + 1);
          }
        }
      }
    }

    const queue: string[] = [];
    for (const [id, deg] of inDegree.entries()) {
      if (deg === 0) queue.push(id);
    }

    const resolved: SkillArtifact[] = [];
    while (queue.length > 0) {
      const u = queue.shift()!;
      resolved.push(nodeMap.get(u)!);

      const neighbors = adj.get(u) || [];
      for (const v of neighbors) {
        inDegree.set(v, inDegree.get(v)! - 1);
        if (inDegree.get(v) === 0) queue.push(v);
      }
    }

    if (resolved.length !== artifacts.length) {
      throw new Error("Cyclic or unresolved dependency detected in skill artifacts.");
    }

    return resolved;
  }
}

// ==========================================
// 4. ADAPTIVE CONTEXT ESCALATION ENGINE
// ==========================================
export class ContextEscalationEngine {
  private currentTier: ContextTier = 0;
  private activeArtifacts = new Set<string>();
  private escalationHistory: string[] = [];
  private tokenBudget = 8000; // default token threshold limit

  public getTier(): ContextTier {
    return this.currentTier;
  }

  public getActiveArtifacts(): string[] {
    return Array.from(this.activeArtifacts);
  }

  public getEscalationHistory(): string[] {
    return [...this.escalationHistory];
  }

  public setTokenBudget(budget: number): void {
    this.tokenBudget = budget;
  }

  public clear(): void {
    this.currentTier = 0;
    this.activeArtifacts.clear();
    this.escalationHistory = [];
  }

  /** Escalates active context level progresively on failure triggers */
  public triggerEscalation(reason: string): void {
    if (this.currentTier < 4) {
      this.currentTier = (this.currentTier + 1) as ContextTier;
      this.escalationHistory.push(`Escalated to Tier ${this.currentTier} due to: ${reason}`);
    }
  }

  /**
   * Projects phase-correct artifacts and filters context based on the current tier.
   */
  public project(allArtifacts: SkillArtifact[], _phase: string): SkillArtifact[] {
    const matched = allArtifacts.filter((art) => {
      // Tier constraints filtering
      if (this.currentTier === 0) return art.phase === "planning";
      if (this.currentTier === 1) return art.phase === "planning" || art.phase === "implementation";
      if (this.currentTier === 2) return art.phase !== "recovery";
      return true; // Tier 3 & 4 includes all recovery artifacts
    });

    const resolved = ArtifactDependencyGraphResolver.resolve(matched);

    // Populate active tracking list
    this.activeArtifacts.clear();
    for (const art of resolved) {
      this.activeArtifacts.add(art.id);
    }

    return this.applyBudgetEviction(resolved);
  }

  /**
   * Phase Lifecycle Cleanup
   * Immediately evicts temporary implementation-only artifacts when transitioning to verification
   */
  public handlePhaseTransition(fromPhase: string, toPhase: string, allArtifacts: SkillArtifact[]): SkillArtifact[] {
    if (fromPhase === "implementation" && toPhase === "verification") {
      // Purge implementation-only Tier 2 elements
      this.activeArtifacts.forEach((artId) => {
        const art = allArtifacts.find((a) => a.id === artId);
        if (art && art.phase === "implementation") {
          this.activeArtifacts.delete(artId);
        }
      });
    }

    const filtered = allArtifacts.filter((art) => this.activeArtifacts.has(art.id));
    return this.applyBudgetEviction(filtered);
  }

  /**
   * Priority Governance: Evicts low priority items first once token count/bytes exceed limits.
   */
  private applyBudgetEviction(artifacts: SkillArtifact[]): SkillArtifact[] {
    let currentCost = artifacts.reduce((sum, art) => sum + Buffer.byteLength(art.content), 0);

    if (currentCost <= this.tokenBudget) return artifacts;

    // Prioritize eviction: low -> medium -> high -> critical
    const priorityWeight = { critical: 4, high: 3, medium: 2, low: 1 };
    const sorted = [...artifacts].sort((a, b) => priorityWeight[b.priorityClass] - priorityWeight[a.priorityClass]);

    const kept: SkillArtifact[] = [];
    let allocated = 0;

    for (const art of sorted) {
      const size = Buffer.byteLength(art.content);
      if (allocated + size <= this.tokenBudget || art.priorityClass === "critical") {
        kept.push(art);
        allocated += size;
      }
    }

    return kept;
  }

  // ==========================================
  // 10. REPLAY-SAFE PERSISTENCE
  // ==========================================
  public serialize(): ProjectionState {
    return {
      currentTier: this.currentTier,
      activeArtifacts: this.getActiveArtifacts(),
      escalationHistory: this.getEscalationHistory(),
      tokenCost: this.tokenBudget
    };
  }

  public deserialize(state: ProjectionState): void {
    this.currentTier = state.currentTier;
    this.activeArtifacts = new Set(state.activeArtifacts);
    this.escalationHistory = [...state.escalationHistory];
    this.tokenBudget = state.tokenCost;
  }
}

// ==========================================
// 11. CONTEXT OBSERVABILITY
// ==========================================
export class ContextObservability {
  private log: { timestamp: number; message: string; tier: ContextTier }[] = [];

  public logProjection(tier: ContextTier, cost: number, signal: number): void {
    this.log.push({
      timestamp: Date.now(),
      message: `Projected Context: Tier ${tier} (Cost: ${cost} bytes, Signal Score: ${signal})`,
      tier
    });
  }

  public getHistory(): { timestamp: number; message: string; tier: ContextTier }[] {
    return [...this.log];
  }

  public clear(): void {
    this.log = [];
  }
}
