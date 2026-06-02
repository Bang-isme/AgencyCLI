import { 
  AutonomyMode, 
  RiskLevel, 
  RiskScore, 
  ApprovalScopeType, 
  TemporaryApprovalWindow, 
  ContinuationPolicy,
  ApprovalRequest
} from "@agency/contracts";
import { RiskAssessor } from "./risk-assessor.js";
import { EventBus } from "../events/event-bus.js";
import fs from "node:fs";
import { applyPatch } from "../utils/ast-compiler.js";
import ts from "typescript";
import { RiskHeuristicRefiner } from "@agency/heuristics";

export class ApprovalPolicyEngine {
  private mode: AutonomyMode = "Balanced";
  private defaultContinuation: ContinuationPolicy = "Reject";
  private defaultTimeoutMs = 60000; // 60s default
  
  // UX Interruption Budget
  private maxApprovalsPerWorkflow = 2;
  private approvalsRequestedCount = 0;
  private maxSilentDurationMs = 4000;
  private maxVisibleRuntimeJargon: "LOW" | "MEDIUM" | "HIGH" = "LOW";

  // Progressive Autonomy Escalation Streak
  private validationStreak = 0;

  // Interruption Memory: Session Lifetime Sticky Denials Cache
  private stickyDenials = new Map<string, Set<string>>();

  // Inherited/Approved branches (inherits child approvals)
  private approvedBranches = new Set<string>();
  
  // Temporary approval windows
  private tempWindow: TemporaryApprovalWindow | null = null;
  
  // Granular whitelisted tools/actions
  private whitelistedTools = new Set<string>();
  private whitelistedPatches = new Set<string>();

  private pendingRequests = new Map<string, ApprovalRequest>();
  private eventBus: EventBus;

  constructor() {
    this.eventBus = EventBus.getInstance();
  }

  private getModeRank(mode: AutonomyMode): number {
    switch (mode) {
      case "Safe": return 1;
      case "Balanced": return 2;
      case "Autonomous": return 3;
      case "CI": return 4;
      default: return 0;
    }
  }

  public setMode(mode: AutonomyMode): void {
    const prevRank = this.getModeRank(this.mode);
    const newRank = this.getModeRank(mode);
    this.mode = mode;
    this.validationStreak = 0; // reset streak on manual change
    if (newRank > prevRank) {
      this.stickyDenials.clear(); // Clear all sticky denials on less restrictive escalation!
    }
  }

  public getMode(): AutonomyMode {
    return this.mode;
  }

  private getDenialKey(action: string, params: Record<string, any>): string {
    if (params.command) {
      return `${action}:command:${params.command}`;
    }
    if (params.filePath) {
      return `${action}:file:${params.filePath}`;
    }
    if (params.patchOperations && Array.isArray(params.patchOperations)) {
      const targets = params.patchOperations.map((p: any) => `${p.filePath}:${p.targetName}:${p.type}`).join("|");
      return `${action}:patches:${targets}`;
    }
    return `${action}:${JSON.stringify(params)}`;
  }

  public recordValidationSuccess(confidence: number, hasReplayDrift: boolean): void {
    if (confidence >= 0.9 && !hasReplayDrift) {
      this.validationStreak++;
      if (this.validationStreak >= 3) {
        this.validationStreak = 0; // Reset streak on escalation
        this.escalateAutonomy();
      }
    } else {
      this.validationStreak = 0;
    }
  }

  public recordConfidence(confidence: number): void {
    if (confidence < 0.4) {
      this.mode = "Safe";
      this.validationStreak = 0;
      console.log("● [Decay] Autonomy level downgraded to Safe mode due to low confidence");
    } else if (confidence < 0.7) {
      if (this.mode === "Autonomous") {
        this.mode = "Balanced";
        this.validationStreak = 0;
        console.log("● [Decay] Autonomy level downgraded to Balanced mode due to warning confidence");
      } else if (this.mode === "Balanced") {
        this.mode = "Safe";
        this.validationStreak = 0;
        console.log("● [Decay] Autonomy level downgraded to Safe mode due to warning confidence");
      }
    }
  }

  private escalateAutonomy(): void {
    if (this.mode === "Safe") {
      this.mode = "Balanced";
      console.log("● [Escalating] Autonomy level raised due to stable execution streak");
    } else if (this.mode === "Balanced") {
      this.mode = "Autonomous";
      console.log("● [Escalating] Autonomy level raised due to stable execution streak");
    }
  }

  public getValidationStreak(): number {
    return this.validationStreak;
  }

  public setContinuationPolicy(policy: ContinuationPolicy): void {
    this.defaultContinuation = policy;
  }

  public setTimeoutMs(ms: number): void {
    this.defaultTimeoutMs = ms;
  }

  // Interruption Budget Controls
  public getInterruptionCount(): number {
    return this.approvalsRequestedCount;
  }

  public resetInterruptionCount(): void {
    this.approvalsRequestedCount = 0;
  }

  public setMaxApprovalsPerWorkflow(limit: number): void {
    this.maxApprovalsPerWorkflow = limit;
  }

  public getMaxApprovalsPerWorkflow(): number {
    return this.maxApprovalsPerWorkflow;
  }

  public getMaxSilentDurationMs(): number {
    return this.maxSilentDurationMs;
  }

  public setMaxSilentDurationMs(ms: number): void {
    this.maxSilentDurationMs = ms;
  }

  public getMaxVisibleRuntimeJargon(): "LOW" | "MEDIUM" | "HIGH" {
    return this.maxVisibleRuntimeJargon;
  }

  public setMaxVisibleRuntimeJargon(level: "LOW" | "MEDIUM" | "HIGH"): void {
    this.maxVisibleRuntimeJargon = level;
  }

  /**
   * Approves an entire execution branch (Inheritance).
   * All future downstream operations belonging to this branch (e.g. file writes, tests, lint) are auto-approved.
   */
  public approveBranch(branchId: string): void {
    this.approvedBranches.add(branchId);
    this.eventBus.publish("approval:branch:authorized", { branchId });
  }

  /**
   * Revokes/clears branch inheritance.
   */
  public revokeBranch(branchId: string): void {
    this.approvedBranches.delete(branchId);
  }

  /**
   * Grants a temporary approval window (e.g., 30 minutes).
   */
  public grantTemporaryWindow(durationMs: number, allowedRiskLevels: RiskLevel[] = ["LOW"]): void {
    this.tempWindow = {
      grantedAt: Date.now(),
      durationMs,
      allowedRiskLevels,
    };
    this.eventBus.publish("approval:temp-window:granted", { durationMs, allowedRiskLevels });
  }

  public clearTemporaryWindow(): void {
    this.tempWindow = null;
  }

  public whitelistTool(toolName: string): void {
    this.whitelistedTools.add(toolName);
  }

  public whitelistPatch(patchType: string): void {
    this.whitelistedPatches.add(patchType);
  }

  /**
   * Evaluates if an action is auto-approved under the current policy, risk score, and inheritance tree.
   * If not, yields or throws a pending request.
   */
  public evaluate(
    action: string, 
    params: Record<string, any> = {}, 
    options: { branchId?: string; scope?: ApprovalScopeType } = {}
  ): { authorized: boolean; risk: RiskScore; reason: string } {
    const risk = RiskAssessor.assessRisk(action, params);
    const scope = options.scope || this.deriveScope(action);

    // 0. Interruption Memory: Sticky Denial Check
    if (options.branchId) {
      const denials = this.stickyDenials.get(options.branchId);
      if (denials) {
        const key = this.getDenialKey(action, params);
        if (denials.has(key)) {
          return { authorized: false, risk, reason: "Auto-rejected repeat command to respect previous denial." };
        }
      }
    }

    // 1. Session / CI Bypass
    if (this.mode === "CI") {
      if (risk.level === "HIGH" && risk.destructive > 0.8) {
        return { authorized: false, risk, reason: "CI mode blocked high destructive action." };
      }
      return { authorized: true, risk, reason: "CI mode auto-approved." };
    }

    // 2. Scope Whitelist checks
    if (scope === "tool-level" && this.whitelistedTools.has(action)) {
      return { authorized: true, risk, reason: `Tool whitelisted: ${action}` };
    }
    if (scope === "patch-level" && params.patchType && this.whitelistedPatches.has(params.patchType)) {
      return { authorized: true, risk, reason: `Patch whitelisted: ${params.patchType}` };
    }

    // 3. Inheritance checks (Branch-level auto-approvals)
    if (options.branchId && this.approvedBranches.has(options.branchId)) {
      // Safe actions inherit full branch approval. Dangerous commands still checked.
      if (risk.level !== "HIGH") {
        return { authorized: true, risk, reason: `Inherited branch approval from: ${options.branchId}` };
      }
    }

    // 4. Temporary window check
    if (this.tempWindow) {
      const elapsed = Date.now() - this.tempWindow.grantedAt;
      if (elapsed < this.tempWindow.durationMs) {
        if (this.tempWindow.allowedRiskLevels.includes(risk.level)) {
          return { authorized: true, risk, reason: "Auto-approved within temporary validation window." };
        }
      } else {
        this.tempWindow = null; // window expired
      }
    }

    // 5. Autonomy Mode evaluation
    switch (this.mode) {
      case "Safe":
        // Always ask human for any mutating actions (LOW risk of no-impact operations can be bypassed)
        if (risk.overall === 0.0) {
          return { authorized: true, risk, reason: "Zero-risk command auto-approved." };
        }
        return { authorized: false, risk, reason: "Safe mode requires explicit human confirmation." };

      case "Balanced":
        // Auto-approve LOW risk. Ask for MEDIUM and HIGH.
        if (risk.level === "LOW") {
          return { authorized: true, risk, reason: "Balanced mode auto-approved LOW risk operation." };
        }
        return { authorized: false, risk, reason: `Balanced mode requires approval for ${risk.level} risk.` };

      case "Autonomous":
        // Auto-approve LOW & MEDIUM. Ask for HIGH risk.
        if (risk.level === "LOW" || risk.level === "MEDIUM") {
          return { authorized: true, risk, reason: "Autonomous mode auto-approved safe/moderate operation." };
        }
        return { authorized: false, risk, reason: `Autonomous mode requires approval for HIGH risk operation.` };

      default:
        return { authorized: false, risk, reason: "Unknown autonomy mode." };
    }
  }

  /**
   * Requests human approval for an operation, creating a paused execution branch
   * without blocking the scheduler or other task execution lanes.
   */
  public async requestApproval(
    action: string,
    params: Record<string, any> = {},
    options: { branchId?: string; scope?: ApprovalScopeType } = {}
  ): Promise<boolean> {
    const evaluation = this.evaluate(action, params, options);
    if (evaluation.authorized) {
      await this.eventBus.publish("approval:automatic:granted", { action, reason: evaluation.reason });
      return true;
    }

    // Interruption budget check to minimize human prompts
    if (this.approvalsRequestedCount >= this.maxApprovalsPerWorkflow) {
      if (evaluation.risk.level !== "HIGH") {
        // Automatically approve LOW/MEDIUM risk once budget is exceeded to keep forward momentum
        const fallbackReason = `Auto-approved ${evaluation.risk.level} risk action to respect UX Interruption Budget (limit: ${this.maxApprovalsPerWorkflow})`;
        await this.eventBus.publish("approval:automatic:granted", { 
          action, 
          reason: `${fallbackReason} (Current interruptions: ${this.approvalsRequestedCount}/${this.maxApprovalsPerWorkflow})`
        });
        return true;
      }
      
      // HIGH risk: fall through to manual prompt (Emergency Interrupt to protect host/codebase)
    }

    this.approvalsRequestedCount++;

    const requestId = `req-${Math.random().toString(36).substring(2, 9)}`;
    const request: ApprovalRequest = {
      id: requestId,
      scope: options.scope || this.deriveScope(action),
      action,
      params,
      risk: evaluation.risk,
      branchId: options.branchId,
      timeoutMs: this.defaultTimeoutMs,
    };

    this.pendingRequests.set(requestId, request);

    // Render the approval card to the console
    this.printApprovalCard(request);

    await this.eventBus.publish("approval:required", request);

    // Auto-continuation promise race
    return new Promise((resolve) => {
      let resolved = false;

      // 1. Setup response listeners
      const onApprove = (evt: any) => {
        const parsed = typeof evt.payload === "string" ? JSON.parse(evt.payload) : evt.payload;
        if (parsed.requestId === requestId) {
          cleanup();
          resolved = true;
          this.validationStreak = 0; // Manual override resets streak!
          try {
            const dim = this.getPrimaryDimension(action);
            const refiner = new RiskHeuristicRefiner(process.cwd());
            refiner.recordOverride(dim, "approve");
          } catch {}
          this.pendingRequests.delete(requestId);
          this.eventBus.publish("approval:granted", { requestId, action });
          resolve(true);
        }
      };

      const onReject = (evt: any) => {
        const parsed = typeof evt.payload === "string" ? JSON.parse(evt.payload) : evt.payload;
        if (parsed.requestId === requestId) {
          cleanup();
          resolved = true;
          this.validationStreak = 0; // Manual override resets streak!
          try {
            const dim = this.getPrimaryDimension(action);
            const refiner = new RiskHeuristicRefiner(process.cwd());
            refiner.recordOverride(dim, "deny");
          } catch {}
          if (options.branchId) {
            if (!this.stickyDenials.has(options.branchId)) {
              this.stickyDenials.set(options.branchId, new Set());
            }
            this.stickyDenials.get(options.branchId)!.add(this.getDenialKey(action, params));
          }
          this.pendingRequests.delete(requestId);
          this.eventBus.publish("approval:rejected", { requestId, action });
          resolve(false);
        }
      };

      this.eventBus.subscribe("approval:response:approve", onApprove);
      this.eventBus.subscribe("approval:response:reject", onReject);

      // 2. Setup continuation policy timeout
      const timer = setTimeout(() => {
        if (resolved) return;
        cleanup();
        resolved = true;
        this.pendingRequests.delete(requestId);

        switch (this.defaultContinuation) {
          case "ProceedAutonomous":
            console.log(`[TIMEOUT] Proceeding autonomously with ${action} under default continue policy.`);
            try {
              const dim = this.getPrimaryDimension(action);
              const refiner = new RiskHeuristicRefiner(process.cwd());
              refiner.recordOverride(dim, "approve");
            } catch {}
            resolve(true);
            break;
          case "ReadonlyFallback":
            console.log(`[TIMEOUT] Downgraded action to Read-Only mode.`);
            try {
              const dim = this.getPrimaryDimension(action);
              const refiner = new RiskHeuristicRefiner(process.cwd());
              refiner.recordOverride(dim, "deny");
            } catch {}
            if (options.branchId) {
              if (!this.stickyDenials.has(options.branchId)) {
                this.stickyDenials.set(options.branchId, new Set());
              }
              this.stickyDenials.get(options.branchId)!.add(this.getDenialKey(action, params));
            }
            resolve(false);
            break;
          case "Reject":
          default:
            console.log(`[TIMEOUT] Auto-rejected action ${action} under default reject policy.`);
            try {
              const dim = this.getPrimaryDimension(action);
              const refiner = new RiskHeuristicRefiner(process.cwd());
              refiner.recordOverride(dim, "deny");
            } catch {}
            if (options.branchId) {
              if (!this.stickyDenials.has(options.branchId)) {
                this.stickyDenials.set(options.branchId, new Set());
              }
              this.stickyDenials.get(options.branchId)!.add(this.getDenialKey(action, params));
            }
            resolve(false);
            break;
        }
      }, this.defaultTimeoutMs);

      const cleanup = () => {
        clearTimeout(timer);
        this.eventBus.unsubscribe("approval:response:approve", onApprove);
        this.eventBus.unsubscribe("approval:response:reject", onReject);
      };
    });
  }

  public getPendingRequests(): ApprovalRequest[] {
    return Array.from(this.pendingRequests.values());
  }

  private astEqual(codeA: string, codeB: string): boolean {
    const cleanNode = (node: ts.Node): any => {
      const res: any = { kind: node.kind };
      if (ts.isIdentifier(node)) {
        res.text = node.text;
      } else if (ts.isLiteralExpression(node)) {
        res.text = node.text;
      }
      const children: any[] = [];
      node.forEachChild(child => {
        children.push(cleanNode(child));
      });
      if (children.length > 0) {
        res.children = children;
      }
      return res;
    };

    try {
      const fileA = ts.createSourceFile("a.ts", codeA, ts.ScriptTarget.Latest, true);
      const fileB = ts.createSourceFile("b.ts", codeB, ts.ScriptTarget.Latest, true);
      const cleanA = JSON.stringify(cleanNode(fileA));
      const cleanB = JSON.stringify(cleanNode(fileB));
      return cleanA === cleanB;
    } catch {
      return false;
    }
  }

  private deriveScope(action: string): ApprovalScopeType {
    if (action.includes("patch") || action.includes("ast")) return "patch-level";
    if (action.includes("run") || action.includes("shell") || action.includes("command")) return "session-level";
    return "tool-level";
  }

  private formatPatchOperationsSummary(patches: any[]): string {
    const bold = "\x1b[1m";
    const reset = "\x1b[0m";
    const green = "\x1b[32m";
    const yellow = "\x1b[33m";
    const red = "\x1b[31m";
    const gray = "\x1b[90m";

    const grouped: Record<string, string[]> = {};
    let collapsedCount = 0;

    for (const p of patches) {
      if (p.filePath) {
        try {
          if (fs.existsSync(p.filePath)) {
            const originalCode = fs.readFileSync(p.filePath, "utf8");
            const modifiedCode = applyPatch(originalCode, p);
            if (this.astEqual(originalCode, modifiedCode)) {
              collapsedCount++;
              continue;
            }
          }
        } catch {
          // Fall through to display normally if error
        }
      }

      const file = p.filePath ? p.filePath.split(/[/\\]/).pop() : "unknown file";
      if (!grouped[file]) grouped[file] = [];

      let details = "";
      if (p.type === "ReplaceMethodBody" && p.meta?.className) {
        details = `${yellow}modify${reset} class ${bold}${p.meta.className}${reset} ➔ method ${bold}${p.targetName}()${reset}`;
      } else if (p.type === "ReplaceMethodBody" || p.type === "ReplaceFunctionBody") {
        details = `${yellow}modify${reset} function ${bold}${p.targetName}()${reset}`;
      } else if (p.type === "InsertFunction") {
        details = `${green}add${reset} function ${bold}${p.targetName}()${reset}`;
      } else if (p.type === "RenameSymbol") {
        details = `${yellow}rename${reset} symbol ${bold}${p.targetName}${reset} ➔ ${bold}${p.replacementContent || "new"}${reset}`;
      } else if (p.type === "ModifyImport") {
        details = `${yellow}import${reset} module ${bold}${p.targetName}${reset}`;
      } else if (p.type === "DeleteNode") {
        details = `${red}remove${reset} node ${bold}${p.targetName}${reset}`;
      } else {
        details = `${yellow}edit${reset} ${p.type} ${bold}${p.targetName}${reset}`;
      }
      grouped[file].push(`    ${details}`);
    }

    const lines: string[] = [];
    if (Object.keys(grouped).length > 0) {
      lines.push(`  ${bold}Changes:${reset}`);
      for (const [file, ops] of Object.entries(grouped)) {
        lines.push(`   📄 ${bold}${file}${reset}`);
        for (const op of ops) {
          lines.push(op);
        }
      }
    }
    if (collapsedCount > 0) {
      lines.push(`  ${gray}● Note: ${collapsedCount} formatting-only changes auto-collapsed.${reset}`);
    }
    return lines.join("\n");
  }

  /**
   * Renders a compact approval card to the console: action, risk, the affected
   * command/file, any structured patch summary, and the choices.
   */
  private printApprovalCard(req: ApprovalRequest): void {
    const color = req.risk.level === "HIGH" ? "\x1b[31;1m" : "\x1b[33;1m"; // Red for HIGH, Yellow for MEDIUM
    const reset = "\x1b[0m";
    const bold = "\x1b[1m";
    const gray = "\x1b[90m";

    const budgetExceeded = this.approvalsRequestedCount > this.maxApprovalsPerWorkflow;

    console.log(`\n${bold}⚠️  Action Requires Approval${reset}`);
    if (budgetExceeded) {
      console.log(`  \x1b[31;1mPast the approval budget (${this.maxApprovalsPerWorkflow}/${this.maxApprovalsPerWorkflow}) — high-risk actions still need your confirmation.${reset}`);
    }
    console.log(`  ${bold}${req.action}${reset} ${gray}(Risk: ${color}${req.risk.level}${reset}${gray})${reset}`);
    if (req.params.command || req.params.filePath) {
      console.log(`  ${gray}${req.params.command || req.params.filePath}${reset}`);
    }

    // Print symbol-grouped AST structural patch summaries if present
    if (req.params.patchOperations && Array.isArray(req.params.patchOperations)) {
      console.log(this.formatPatchOperationsSummary(req.params.patchOperations));
    } else if (req.params.patch) {
      console.log(this.formatPatchOperationsSummary([req.params.patch]));
    }

    console.log(`  ${bold}[y]${reset} Yes  ${bold}[a]${reset} Always  ${bold}[n]${reset} No  ${bold}[s]${reset} Sandbox\n`);
  }

  private getPrimaryDimension(action: string): "filesystem" | "shell" | "network" | "privilege" | "destructive" {
    if (action.includes("run") || action.includes("shell") || action.includes("command")) return "shell";
    if (action.includes("patch") || action.includes("ast") || action.includes("write")) return "filesystem";
    if (action.includes("url") || action.includes("scrape") || action.includes("web") || action.includes("fetch")) return "network";
    if (action.includes("delete") || action.includes("rm") || action.includes("remove")) return "destructive";
    return "privilege";
  }
}
