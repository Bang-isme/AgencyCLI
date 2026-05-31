import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import {
  ContextSufficiencyModel,
  TopologyDetector,
  ArtifactDependencyGraphResolver,
  ContextEscalationEngine,
  ContextObservability,
  SkillArtifact
} from "../skill/context-delivery.js";
import * as fs from "node:fs";
import { join } from "node:path";

describe("Harness-Grade Adaptive Context Delivery Suite", () => {
  
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ==========================================
  // 1. ADAPTIVE ESCALATION TEST
  // ==========================================
  describe("1. Adaptive Context Escalation", () => {
    it("should progressively escalate context tiers and project phase-correct artifacts on failures", () => {
      const engine = new ContextEscalationEngine();
      engine.setTokenBudget(10000);

      const artifacts: SkillArtifact[] = [
        { id: "art-1", type: "reference", content: "Architecture doc", phase: "planning", priorityClass: "high" },
        { id: "art-2", type: "template", content: "React component template", phase: "implementation", priorityClass: "high" },
        { id: "art-3", type: "script", content: "pnpm test execution script", phase: "verification", priorityClass: "critical" },
        { id: "art-4", type: "workflow", content: "Recovery recovery script", phase: "recovery", priorityClass: "critical" }
      ];

      // TIER 0: Start minimal (Planning phase only projected)
      expect(engine.getTier()).toBe(0);
      const tier0Proj = engine.project(artifacts, "planning");
      expect(tier0Proj.some(a => a.id === "art-1")).toBe(true);
      expect(tier0Proj.some(a => a.id === "art-2")).toBe(false);

      // Trigger escalation (e.g. validation error)
      engine.triggerEscalation("First validation test failure");
      expect(engine.getTier()).toBe(1);

      // TIER 1: Projected Planning + Implementation
      const tier1Proj = engine.project(artifacts, "implementation");
      expect(tier1Proj.some(a => a.id === "art-1")).toBe(true);
      expect(tier1Proj.some(a => a.id === "art-2")).toBe(true);
      expect(tier1Proj.some(a => a.id === "art-4")).toBe(false);

      // Trigger second escalation -> Tier 2
      engine.triggerEscalation("Retry attempt failed");
      engine.triggerEscalation("Severe recovery triggered");
      expect(engine.getTier()).toBe(3);

      // TIER 3: Includes all recovery workflows
      const tier3Proj = engine.project(artifacts, "recovery");
      expect(tier3Proj.some(a => a.id === "art-4")).toBe(true);
    });
  });

  // ==========================================
  // 2. DETERMINISTIC REPLAY PROJECTION TEST
  // ==========================================
  describe("2. Deterministic Replay Context Projection", () => {
    it("should serialize, deserialize, and deterministically restore identical context states", () => {
      const engine1 = new ContextEscalationEngine();
      engine1.triggerEscalation("Initial failure");
      engine1.triggerEscalation("Stale lease retry");

      const state = engine1.serialize();

      // Create a second clean engine
      const engine2 = new ContextEscalationEngine();
      engine2.deserialize(state);

      expect(engine2.getTier()).toBe(engine1.getTier());
      expect(engine2.getEscalationHistory()).toEqual(engine1.getEscalationHistory());
      expect(engine2.getActiveArtifacts()).toEqual(engine1.getActiveArtifacts());
    });
  });

  // ==========================================
  // 3. TOPOLOGY DETECTION TEST
  // ==========================================
  describe("3. Project Topology Detection", () => {
    it("should automatically detect Next.js monorepos using cached light fs lookups", () => {
      const detector = new TopologyDetector();
      const testDir = join(process.cwd(), `.agency-temp-topology-test-${Date.now()}`);

      try {
        fs.mkdirSync(testDir, { recursive: true });
        fs.writeFileSync(join(testDir, "pnpm-workspace.yaml"), "# workspace", "utf8");
        fs.writeFileSync(join(testDir, "next.config.js"), "module.exports = {}", "utf8");
        fs.writeFileSync(join(testDir, "tailwind.config.js"), "module.exports = {}", "utf8");
        fs.mkdirSync(join(testDir, "prisma"), { recursive: true });
        fs.writeFileSync(join(testDir, "prisma/schema.prisma"), "datasource db {}", "utf8");

        const ecosystem = detector.detectEcosystem(testDir);
        
        expect(ecosystem.isMonorepo).toBe(true);
        expect(ecosystem.packageManager).toBe("pnpm");
        expect(ecosystem.framework).toBe("nextjs");
        expect(ecosystem.styling).toBe("tailwind");
        expect(ecosystem.orm).toBe("prisma");

        // Verify cache: subsequent call returns identical object
        const cached = detector.detectEcosystem(testDir);
        expect(cached).toBe(ecosystem); // strict reference equality check!
      } finally {
        // Safe clean up
        try {
          fs.rmSync(testDir, { recursive: true, force: true });
        } catch {
          // ignore cleanup errors
        }
      }
    });
  });

  // ==========================================
  // 4. CONTEXT BUDGET OVERLOAD TEST
  // ==========================================
  describe("4. Context Budget & Priority Eviction", () => {
    it("should evict low priority reference files first when token limits are exceeded", () => {
      const engine = new ContextEscalationEngine();
      
      // Budget limit is 100 bytes
      engine.setTokenBudget(100);

      const artifacts: SkillArtifact[] = [
        { id: "art-low", type: "reference", content: "X".repeat(60), phase: "planning", priorityClass: "low" },
        { id: "art-med", type: "reference", content: "Y".repeat(60), phase: "planning", priorityClass: "medium" },
        { id: "art-crit", type: "reference", content: "Z".repeat(50), phase: "planning", priorityClass: "critical" }
      ];

      // Total size is 170 bytes (exceeds 100).
      // Critical is kept first, low and medium must be evicted.
      const projected = engine.project(artifacts, "planning");
      
      expect(projected.some(a => a.id === "art-crit")).toBe(true);
      expect(projected.some(a => a.id === "art-low")).toBe(false);
      expect(projected.length).toBeLessThan(artifacts.length);
    });
  });

  // ==========================================
  // 5. PHASE LIFECYCLE CLEANUP & DEPENDENCY TESTS
  // ==========================================
  describe("5. Lifecycle Cleanup & Dependency Resolve", () => {
    it("should automatically resolve topological dependency graphs and throw on cycles", () => {
      const artifacts: SkillArtifact[] = [
        { id: "starter.ts", type: "template", content: "Component skeleton", phase: "implementation", priorityClass: "high", dependsOn: ["schema.ts"] },
        { id: "schema.ts", type: "reference", content: "DB schema definitions", phase: "planning", priorityClass: "critical" }
      ];

      const resolved = ArtifactDependencyGraphResolver.resolve(artifacts);
      
      // schema.ts has 0 in-degree, starter.ts depends on schema.ts.
      // Topologically sorted order must place schema.ts first.
      expect(resolved[0].id).toBe("schema.ts");
      expect(resolved[1].id).toBe("starter.ts");
    });

    it("should throw a structured error on cyclic dependencies", () => {
      const artifacts: SkillArtifact[] = [
        { id: "A", type: "reference", content: "A", phase: "planning", priorityClass: "high", dependsOn: ["B"] },
        { id: "B", type: "reference", content: "B", phase: "planning", priorityClass: "high", dependsOn: ["A"] }
      ];

      expect(() => {
        ArtifactDependencyGraphResolver.resolve(artifacts);
      }).toThrow("Cyclic or unresolved dependency detected");
    });

    it("should immediately clean up phase-scoped temporary artifacts on transition", () => {
      const engine = new ContextEscalationEngine();
      engine.triggerEscalation("Task implementation started");
      
      const artifacts: SkillArtifact[] = [
        { id: "art-1", type: "template", content: "implementation skeleton", phase: "implementation", priorityClass: "high" },
        { id: "art-2", type: "reference", content: "Planning architecture details", phase: "planning", priorityClass: "critical" }
      ];

      engine.project(artifacts, "implementation");
      expect(engine.getActiveArtifacts()).toContain("art-1");

      // Transition implementation -> verification: implementation artifacts should be purged
      const transitionResult = engine.handlePhaseTransition("implementation", "verification", artifacts);
      
      expect(transitionResult.some(a => a.id === "art-1")).toBe(false);
      expect(transitionResult.some(a => a.id === "art-2")).toBe(true);
    });
  });

  // ==========================================
  // 6. CONTEXT SUFFICIENCY DYNAMIC WEIGHTING
  // ==========================================
  describe("6. Context Sufficiency Dynamic Weighting", () => {
    it("should dynamically calculate sufficiency based on execution phase weights", () => {
      // Create a score where topologyCoverage is 0.9, but verificationCoverage is 0.1
      const score = {
        topologyCoverage: 0.9,
        taskCoverage: 0.8,
        verificationCoverage: 0.1,
        recoveryCoverage: 0.0,
        tokenCost: 1000,
        operationalDensity: 1.0
      };

      // In Planning Phase: wTopology (0.6) + wTask (0.3) makes it highly sufficient
      // Sum = 0.6 * 0.9 + 0.3 * 0.8 = 0.54 + 0.24 = 0.78 (Sufficient >= 0.75)
      expect(ContextSufficiencyModel.isSufficient(score, "planning")).toBe(true);

      // In Verification Phase: wTopology (0.2) + wTask (0.2) + wVerification (0.5) makes it insufficient
      // Sum = 0.2 * 0.9 + 0.2 * 0.8 + 0.5 * 0.1 = 0.18 + 0.16 + 0.05 = 0.39 (< 0.75)
      expect(ContextSufficiencyModel.isSufficient(score, "verification")).toBe(false);
    });
  });
});
