import { beforeEach, describe, expect, it } from "vitest";
import { RiskAssessor } from "../approval/risk-assessor.js";
import { ApprovalPolicyEngine } from "../approval/approval-policy-engine.js";
import { EventBus } from "../events/event-bus.js";
import { RiskHeuristicRefiner } from "@agency/heuristics";

describe("Autonomy Governance: Approval Policy System", () => {
  beforeEach(() => {
    RiskHeuristicRefiner.clearTestAdjustments();
  });
  describe("RiskAssessor Scoring System", () => {
    it("should score low-risk safe operations correctly", () => {
      const score = RiskAssessor.assessRisk("write_to_file", { filePath: "packages/core/src/utils.ts" });
      expect(score.level).toBe("LOW");
      expect(score.overall).toBeLessThan(0.3);
    });

    it("should score medium-risk security middleware files correctly", () => {
      const score = RiskAssessor.assessRisk("write_to_file", { filePath: "packages/security/src/auth-middleware.ts" });
      expect(score.level).toBe("MEDIUM");
      expect(score.overall).toBeGreaterThanOrEqual(0.3);
      expect(score.overall).toBeLessThan(0.7);
    });

    it("should score high-risk database migrations correctly", () => {
      const score = RiskAssessor.assessRisk("write_to_file", { filePath: "packages/db/init-migrations.sql" });
      expect(score.level).toBe("HIGH");
    });

    it("should score high-risk dangerous shell commands correctly", () => {
      const score = RiskAssessor.assessRisk("run_command", { command: "rm -rf /" });
      expect(score.level).toBe("HIGH");
      expect(score.overall).toBeGreaterThanOrEqual(0.7);
    });

    it("should score lint and test tasks as low-risk correctly", () => {
      const score = RiskAssessor.assessRisk("run_command", { command: "pnpm test" });
      expect(score.level).toBe("LOW");
    });
  });

  describe("ApprovalPolicyEngine Autonomy Policies", () => {
    it("should respect SafeMode (always ask human)", () => {
      const engine = new ApprovalPolicyEngine();
      engine.setMode("Safe");

      const res = engine.evaluate("write_to_file", { filePath: "test.ts" });
      expect(res.authorized).toBe(false);
    });

    it("should respect BalancedMode (auto-approve LOW, ask for MEDIUM/HIGH)", () => {
      const engine = new ApprovalPolicyEngine();
      engine.setMode("Balanced");

      const lowRiskRes = engine.evaluate("write_to_file", { filePath: "test.ts" });
      expect(lowRiskRes.authorized).toBe(true);

      const highRiskRes = engine.evaluate("run_command", { command: "rm -rf /" });
      expect(highRiskRes.authorized).toBe(false);
    });

    it("should respect AutonomousMode (auto-approve LOW/MEDIUM, ask for HIGH)", () => {
      const engine = new ApprovalPolicyEngine();
      engine.setMode("Autonomous");

      const mediumRiskRes = engine.evaluate("write_to_file", { filePath: "packages/security/src/auth-middleware.ts" });
      expect(mediumRiskRes.authorized).toBe(true);

      const highRiskRes = engine.evaluate("run_command", { command: "rm -rf /" });
      expect(highRiskRes.authorized).toBe(false);
    });

    it("should respect temporary validation windows", () => {
      const engine = new ApprovalPolicyEngine();
      engine.setMode("Safe"); // normally blocks everything

      // Grant a temporary 5-minute auto-approval window for LOW risk
      engine.grantTemporaryWindow(300000, ["LOW"]);

      const res = engine.evaluate("write_to_file", { filePath: "test.ts" });
      expect(res.authorized).toBe(true);
    });

    it("should support branch-level inheritance rule propagation", () => {
      const engine = new ApprovalPolicyEngine();
      engine.setMode("Safe"); // normally blocks everything

      // User authorizes the task branch
      engine.approveBranch("refactor-auth-system");

      // Evaluation for action inside the approved branch
      const res = engine.evaluate(
        "write_to_file", 
        { filePath: "packages/security/src/auth-middleware.ts" },
        { branchId: "refactor-auth-system" }
      );
      
      expect(res.authorized).toBe(true);
    });

    it("should respect ContinuationPolicy timeout fallbacks", async () => {
      const engine = new ApprovalPolicyEngine();
      engine.setMode("Safe");
      engine.setTimeoutMs(100); // 100ms quick timeout
      engine.setContinuationPolicy("ProceedAutonomous");

      // Since timeout fires and policy is ProceedAutonomous, it resolves true
      const res = await engine.requestApproval("write_to_file", { filePath: "test.ts" });
      expect(res).toBe(true);
    });

    it("should resolve true upon receiving prompt responses", async () => {
      const engine = new ApprovalPolicyEngine();
      engine.setMode("Safe");
      engine.setTimeoutMs(5000);

      // Async publish of user approval
      const eventBus = EventBus.getInstance();
      const promise = engine.requestApproval("write_to_file", { filePath: "test.ts" });

      // Find the request ID to target the response to
      setTimeout(async () => {
        const requests = engine.getPendingRequests();
        expect(requests).toHaveLength(1);
        const reqId = requests[0].id;
        await eventBus.publish("approval:response:approve", { requestId: reqId });
      }, 50);

      const res = await promise;
      expect(res).toBe(true);
    });

    it("should respect UX Interruption Budget limits and auto-approve subsequent LOW/MEDIUM actions", async () => {
      const engine = new ApprovalPolicyEngine();
      engine.setMode("Safe"); // Safe mode normally prompts for everything
      engine.setMaxApprovalsPerWorkflow(2);
      engine.setTimeoutMs(10); // Very quick timeout for prompt budget consumption
      engine.setContinuationPolicy("Reject"); // Default to reject on timeout

      // Trigger 2 manual prompts (which will timeout and reject in 10ms each)
      const res1 = await engine.requestApproval("write_to_file", { filePath: "test.ts" });
      const res2 = await engine.requestApproval("write_to_file", { filePath: "test.ts" });
      
      expect(res1).toBe(false);
      expect(res2).toBe(false);
      expect(engine.getInterruptionCount()).toBe(2);

      // Trigger 3rd operation (LOW risk write_to_file). It should be auto-approved to respect the budget, without timing out!
      const startTime = Date.now();
      const res3 = await engine.requestApproval("write_to_file", { filePath: "test.ts" });
      const duration = Date.now() - startTime;

      expect(res3).toBe(true); // Should auto-approve!
      expect(duration).toBeLessThan(150); // Should resolve instantly (under 150ms) without waiting for timeout!
      expect(engine.getInterruptionCount()).toBe(2); // Count remains 2
    });

    it("should enforce emergency interrupt for subsequent HIGH risk operations even when budget is exhausted", async () => {
      const engine = new ApprovalPolicyEngine();
      engine.setMode("Safe");
      engine.setMaxApprovalsPerWorkflow(1); // Budget of only 1 prompt!
      engine.setTimeoutMs(10);
      engine.setContinuationPolicy("Reject");

      // 1. Consume the single budget prompt with a LOW risk action (will reject on timeout)
      const res1 = await engine.requestApproval("write_to_file", { filePath: "test.ts" });
      expect(res1).toBe(false);
      expect(engine.getInterruptionCount()).toBe(1);

      // 2. Trigger a 2nd LOW risk action. It should be auto-approved to respect budget!
      const res2 = await engine.requestApproval("write_to_file", { filePath: "test.ts" });
      expect(res2).toBe(true);

      // 3. Trigger a HIGH risk action. It should NOT be auto-approved, it must prompt/timeout (emergency interrupt)!
      const res3 = await engine.requestApproval("run_command", { command: "rm -rf /" });
      expect(res3).toBe(false); // High risk does not get auto-approved, times out & rejects
    });

    it("should semantically group and format PatchOperations for calm visual UX card presentation", async () => {
      const engine = new ApprovalPolicyEngine();
      engine.setMode("Safe");
      engine.setTimeoutMs(10);
      engine.setContinuationPolicy("Reject");

      const patches = [
        {
          type: "ReplaceMethodBody",
          filePath: "packages/core/src/events/event-bus.ts",
          targetName: "publish",
          meta: { className: "EventBus" },
        },
        {
          type: "InsertFunction",
          filePath: "packages/core/src/utils/ast-compiler.ts",
          targetName: "newHelperFunction",
        },
      ];

      // Request approval for an AST patch with structured operations
      const res = await engine.requestApproval("apply_ast_patch", { patchOperations: patches });
      expect(res).toBe(false); // Times out and rejects as expected, but verifies formatting logic works safely
    });

    describe("Codex UX Invariants: Progressive Autonomy Escalation", () => {
      it("should escalate mode after a streak of 3 successful high confidence validations", () => {
        const engine = new ApprovalPolicyEngine();
        engine.setMode("Safe");
        expect(engine.getMode()).toBe("Safe");

        // 1st success
        engine.recordValidationSuccess(0.95, false);
        expect(engine.getMode()).toBe("Safe");
        expect(engine.getValidationStreak()).toBe(1);

        // 2nd success
        engine.recordValidationSuccess(0.9, false);
        expect(engine.getMode()).toBe("Safe");
        expect(engine.getValidationStreak()).toBe(2);

        // 3rd success triggers escalation
        engine.recordValidationSuccess(1.0, false);
        expect(engine.getMode()).toBe("Balanced");
        expect(engine.getValidationStreak()).toBe(0);

        // Another streak of 3 escalates to Autonomous
        engine.recordValidationSuccess(0.9, false);
        engine.recordValidationSuccess(0.9, false);
        engine.recordValidationSuccess(0.9, false);
        expect(engine.getMode()).toBe("Autonomous");
      });

      it("should reset streak on manual mode change", () => {
        const engine = new ApprovalPolicyEngine();
        engine.setMode("Safe");
        engine.recordValidationSuccess(0.95, false);
        expect(engine.getValidationStreak()).toBe(1);

        engine.setMode("Balanced");
        expect(engine.getValidationStreak()).toBe(0);
      });
    });

    describe("Codex UX Invariants: Interruption Memory & Sticky Denial", () => {
      it("should auto-reject duplicate attempts on the active branch after a rejection", async () => {
        const engine = new ApprovalPolicyEngine();
        engine.setMode("Safe");
        engine.setTimeoutMs(10);
        engine.setContinuationPolicy("Reject");

        // First attempt gets rejected on timeout fallback (returns false)
        const res1 = await engine.requestApproval(
          "write_to_file", 
          { filePath: "packages/core/src/critical.ts" },
          { branchId: "feature-branch-1" }
        );
        expect(res1).toBe(false);

        // Second attempt is similar on the same branch -> should be auto-rejected instantly (no timeout wait)
        const startTime = Date.now();
        const res2 = await engine.evaluate(
          "write_to_file", 
          { filePath: "packages/core/src/critical.ts" },
          { branchId: "feature-branch-1" }
        );
        const duration = Date.now() - startTime;

        expect(res2.authorized).toBe(false);
        expect(res2.reason).toBe("Auto-rejected repeat command to respect previous denial.");
        expect(duration).toBeLessThan(150);
      });

      it("should clear denials cache when manually escalating to less restrictive autonomy mode", async () => {
        const engine = new ApprovalPolicyEngine();
        engine.setMode("Safe");
        engine.setTimeoutMs(10);
        engine.setContinuationPolicy("Reject");

        // Deny first attempt
        await engine.requestApproval(
          "write_to_file", 
          { filePath: "packages/core/src/critical.ts" },
          { branchId: "feature-branch-2" }
        );

        // Verify it is sticky denied
        const resSticky = engine.evaluate(
          "write_to_file", 
          { filePath: "packages/core/src/critical.ts" },
          { branchId: "feature-branch-2" }
        );
        expect(resSticky.authorized).toBe(false);
        expect(resSticky.reason).toBe("Auto-rejected repeat command to respect previous denial.");

        // Manually change mode to less restrictive Balanced
        engine.setMode("Balanced");

        // Verify sticky denials cleared and it evaluates normally under Balanced mode (auto-approved since it is LOW risk)
        const resCleared = engine.evaluate(
          "write_to_file", 
          { filePath: "packages/core/src/critical.ts" },
          { branchId: "feature-branch-2" }
        );
        expect(resCleared.authorized).toBe(true);
        expect(resCleared.reason).toContain("Balanced mode auto-approved");
      });
    });

    describe("Codex UX Invariants: Confidence Decay System", () => {
      it("should downgrade autonomy mode by one level when confidence falls below 0.7", () => {
        const engine = new ApprovalPolicyEngine();
        engine.setMode("Autonomous");

        engine.recordConfidence(0.65);
        expect(engine.getMode()).toBe("Balanced");

        engine.recordConfidence(0.6);
        expect(engine.getMode()).toBe("Safe");
      });

      it("should downgrade directly to Safe mode when confidence falls below 0.4", () => {
        const engine = new ApprovalPolicyEngine();
        engine.setMode("Autonomous");

        engine.recordConfidence(0.3);
        expect(engine.getMode()).toBe("Safe");
      });
    });
  });
});
