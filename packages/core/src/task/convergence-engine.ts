import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { DagTaskNode } from "@agency/contracts";
import { TaskCheckpoint, FileMutation, BuildFailure, RuntimeExecutionState } from "./checkpoint.js";

export interface StructuralConvergence {
  unresolvedDependencyCount: number;
  executionFrontierSize: number;
  blockedNodeCount: number;
  completedObjectiveRatio: number;
  retryGraphExpansionRate: number;
}

export type RecoveryLevel = 0 | 1 | 2 | 3 | 4 | 5 | 6;

export interface StrategyWeight {
  type: string;
  weight: number;
  repetition: number;
}

/**
 * Structural Convergence and Autonomous Repair Engine.
 */
export class ConvergenceEngine {
  /**
   * Computes the structural metrics of the DAG state.
   */
  public static calculateStructural(nodes: Record<string, DagTaskNode>): StructuralConvergence {
    const list = Object.values(nodes);
    const total = list.length;
    const completed = list.filter(n => n.state === "COMPLETED" || n.state === "SKIPPED").length;

    // unresolved dependency count
    let unresolvedDeps = 0;
    let blockedCount = 0;
    let frontierSize = 0;

    for (const node of list) {
      if (node.state === "PENDING") {
        const hasUnresolved = node.dependencies.some(depId => {
          const dep = nodes[depId];
          return !dep || (dep.state !== "COMPLETED" && dep.state !== "SKIPPED");
        });
        if (hasUnresolved) {
          blockedCount++;
        } else {
          frontierSize++;
        }
      }
      unresolvedDeps += node.dependencies.filter(depId => {
        const dep = nodes[depId];
        return !dep || (dep.state !== "COMPLETED" && dep.state !== "SKIPPED");
      }).length;
    }

    // calculate retry graph expansion rate
    const totalAttempts = list.reduce((acc, n) => acc + (n.attempts || 0), 0);
    const retryRate = total > 0 ? totalAttempts / total : 0;

    return {
      unresolvedDependencyCount: unresolvedDeps,
      executionFrontierSize: frontierSize,
      blockedNodeCount: blockedCount,
      completedObjectiveRatio: total > 0 ? completed / total : 1.0,
      retryGraphExpansionRate: retryRate,
    };
  }

  /**
   * Evaluates the absolute convergence score.
   */
  public static calculateScore(
    state: RuntimeExecutionState,
    structural: StructuralConvergence
  ): number {
    let score = structural.completedObjectiveRatio * 0.4;

    // Reward low unresolved dependencies
    if (structural.unresolvedDependencyCount === 0) score += 0.2;
    else score += Math.max(0, 0.2 - structural.unresolvedDependencyCount * 0.02);

    // Reward low retry expansion
    score += Math.max(0, 0.2 - (structural.retryGraphExpansionRate - 1) * 0.1);

    // Reward verification success ratio
    const verifications = state.verificationResults || [];
    if (verifications.length > 0) {
      const passed = verifications.filter(v => v.passed).length;
      score += (passed / verifications.length) * 0.2;
    } else {
      score += 0.2;
    }

    return Math.min(1.0, Math.max(0.0, score));
  }

  /**
   * Detects circular oscillation.
   */
  public static detectOscillation(buildFailures: BuildFailure[], mutations: FileMutation[]): boolean {
    if (buildFailures.length < 3) return false;

    // 1. Consecutive identical build errors
    const last3Failures = buildFailures.slice(-3);
    if (
      last3Failures[0]?.normalizedHash === last3Failures[1]?.normalizedHash &&
      last3Failures[1]?.normalizedHash === last3Failures[2]?.normalizedHash
    ) {
      return true;
    }

    // 2. Oscillating file edit cycles (e.g. file A -> B -> A -> B)
    if (mutations.length >= 4) {
      const last4 = mutations.slice(-4);
      if (
        last4[0]?.file === last4[2]?.file &&
        last4[1]?.file === last4[3]?.file &&
        last4[0]?.file !== last4[1]?.file
      ) {
        return true;
      }
    }

    return false;
  }

  /**
   * Computes strategy entropy and selects the best candidate strategy.
   */
  public static selectRecoveryStrategy(attempted: string[]): string {
    const strategies = ["targeted", "isolation", "rebuild", "rollback", "compaction", "terminate"];
    const weights: Record<string, StrategyWeight> = {
      targeted: { type: "targeted", weight: 1.0, repetition: 0 },
      isolation: { type: "isolation", weight: 0.9, repetition: 0 },
      rebuild: { type: "rebuild", weight: 0.8, repetition: 0 },
      rollback: { type: "rollback", weight: 0.7, repetition: 0 },
      compaction: { type: "compaction", weight: 0.5, repetition: 0 },
      terminate: { type: "terminate", weight: 0.2, repetition: 0 }
    };

    // Calculate repetition
    for (const type of attempted) {
      if (weights[type]) {
        weights[type]!.repetition++;
      }
    }

    // Apply entropy decay weights
    for (const key of Object.keys(weights)) {
      const w = weights[key]!;
      w.weight = w.weight * Math.pow(0.5, w.repetition);
    }

    // Return the strategy with highest weight
    let best = "targeted";
    let maxWeight = -1;
    for (const key of strategies) {
      const w = weights[key]!;
      if (w.weight > maxWeight) {
        maxWeight = w.weight;
        best = key;
      }
    }

    return best;
  }

  /**
   * Computes standard unified-like diff format patch.
   */
  public static makePatch(original: string | null, mutated: string | null): string {
    const orig = original ?? "";
    const mut = mutated ?? "";
    if (orig === mut) return "";
    return JSON.stringify({ before: orig, after: mut });
  }

  /**
   * Applies unified-like diff patch operation.
   */
  public static applyPatch(original: string | null, patchStr: string): string {
    try {
      const patch = JSON.parse(patchStr) as { before: string; after: string };
      return patch.after;
    } catch {
      return original ?? "";
    }
  }

  /**
   * Consolidates Delta Checkpoints and compaction.
   */
  public static compactDeltas(cp: TaskCheckpoint): void {
    if (!cp.executionState) return;
    const state = cp.executionState;
    if (state.fileMutationGraph.length <= 20) return;

    // Consolidate intermediate mutations into baseline JSON representation
    const consolidatedMap = new Map<string, FileMutation>();
    for (const mut of state.fileMutationGraph) {
      if (!consolidatedMap.has(mut.file)) {
        consolidatedMap.set(mut.file, mut);
      } else {
        const existing = consolidatedMap.get(mut.file)!;
        consolidatedMap.set(mut.file, {
          ...mut,
          originalContent: existing.originalContent, // Preserve oldest baseline content
        });
      }
    }

    state.fileMutationGraph = Array.from(consolidatedMap.values());
    state.checkpoints.push({
      timestamp: Date.now(),
      label: "DELTA_COMPACTION",
      metrics: {
        convergenceScore: state.convergenceScore,
        stagnationScore: state.stagnationScore
      }
    });

    state.replayLog = state.replayLog || [];
    state.replayLog.push(`[COMPACTION] Delta mutations compacted at ${new Date().toISOString()}`);
  }

  /**
   * Reverts physical files mutated by the target node in the main workspace.
   */
  public static async applyCausalRollback(
    projectRoot: string,
    state: RuntimeExecutionState,
    nodeId: string
  ): Promise<string[]> {
    const rolledBackFiles: string[] = [];
    const mutations = state.fileMutationGraph || [];

    // Filter mutations matching current task node as causal parent
    const matches = mutations.filter(m => m.causalParent === nodeId || m.rollbackCheckpointId === nodeId);
    
    // Perform chronological reverse ordering rollbacks
    for (let i = matches.length - 1; i >= 0; i--) {
      const mut = matches[i]!;
      const fullPath = resolve(projectRoot, mut.file);
      try {
        const fs = await import("node:fs");
        if (mut.originalContent === null) {
          if (fs.existsSync(fullPath)) {
            fs.unlinkSync(fullPath);
          }
        } else {
          fs.writeFileSync(fullPath, mut.originalContent, "utf8");
        }
        rolledBackFiles.push(mut.file);
      } catch (err) {
        // Log error but continue other rollbacks
      }
    }

    // Keep mutations not rolled back
    state.fileMutationGraph = mutations.filter(m => m.causalParent !== nodeId && m.rollbackCheckpointId !== nodeId);
    state.replayLog = state.replayLog || [];
    state.replayLog.push(`[ROLLBACK] Reverted mutations for task node ${nodeId}`);

    return rolledBackFiles;
  }

  /**
   * In-memory package dependency analysis.
   */
  public static parseMonorepoDependencies(projectRoot: string): Record<string, string[]> {
    const deps: Record<string, string[]> = {};
    const pkgs = ["packages/core", "packages/tui", "packages/cli", "packages/providers", "packages/governance", "packages/contracts", "packages/browser", "packages/heuristics", "packages/security", "packages/telemetry", "packages/workspace", "packages/memory", "packages/tooling", "packages/skills-bridge", "packages/benchmark"];

    for (const pkg of pkgs) {
      const pkgJsonPath = join(projectRoot, pkg, "package.json");
      if (existsSync(pkgJsonPath)) {
        try {
          const json = JSON.parse(readFileSync(pkgJsonPath, "utf8")) as any;
          const pkgName = json.name || pkg;
          deps[pkgName] = [];
          const allDeps = {
            ...(json.dependencies || {}),
            ...(json.devDependencies || {}),
            ...(json.peerDependencies || {})
          };
          for (const [dName, val] of Object.entries(allDeps)) {
            if (val === "workspace:*") {
              deps[pkgName]!.push(dName);
            }
          }
        } catch {
          // ignore parsing error
        }
      }
    }
    return deps;
  }

  /**
   * Writes detailed post-mortem diagnostic log.
   */
  public static writePostMortem(projectRoot: string, cp: TaskCheckpoint, errorMsg: string): void {
    const diagnosticsDir = join(projectRoot, ".agency");
    mkdirSync(diagnosticsDir, { recursive: true });

    const logPath = join(diagnosticsDir, "autonomous-postmortem.log");
    const state = cp.executionState;

    const data = {
      timestamp: new Date().toISOString(),
      checkpointId: cp.id,
      error: errorMsg,
      structuralMetrics: cp.dagState?.nodes ? ConvergenceEngine.calculateStructural(cp.dagState.nodes) : null,
      convergenceScore: state?.convergenceScore ?? 0,
      stagnationScore: state?.stagnationScore ?? 0,
      strategyLineage: state?.replayLog ?? [],
      mutationsCount: state?.fileMutationGraph?.length ?? 0
    };

    writeFileSync(logPath, JSON.stringify(data, null, 2) + "\n", "utf8");
  }
}
