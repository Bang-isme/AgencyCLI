import { RiskScore, RiskLevel } from "@agency/contracts";
import { isDestructiveCommand } from "./patterns.js";
import { RiskHeuristicRefiner } from "@agency/heuristics";

export class RiskAssessor {
  /**
   * Assesses the risk of an action and its parameters, applying dynamic ML adjustments.
   */
  public static assessRisk(
    action: string, 
    params: Record<string, any> = {},
    projectRoot: string = process.cwd()
  ): RiskScore {
    let filesystem = 0.0;
    let shell = 0.0;
    let network = 0.0;
    let privilege = 0.0;
    let impact = 0.1;
    let destructive = 0.0;

    // 1. Filesystem Risk Evaluation
    if (action.includes("write") || action.includes("content") || action.includes("patch")) {
      filesystem = 0.2; // standard write (LOW risk)
      const filePath = params.filePath || params.path || "";
      
      // High filesystem risk for core, auth, configuration files, and migrations
      if (
        filePath.includes("auth") || 
        filePath.includes("security") || 
        filePath.includes("config") ||
        filePath.includes("middleware")
      ) {
        filesystem = 0.6;
      }
      
      if (filePath.includes("migration") || filePath.includes("db/init") || filePath.endsWith(".sql")) {
        filesystem = 0.8;
      }
    }

    if (action.includes("delete") || action.includes("rm") || action.includes("remove")) {
      filesystem = 0.9;
      destructive = 0.9;
    }

    // 2. Shell Command Evaluation
    if (action === "run_command" || action === "shell") {
      const command = params.command || "";
      shell = 0.5; // base shell risk

      if (isDestructiveCommand(command)) {
        shell = 1.0;
        destructive = 1.0;
        privilege = 0.8;
      }

      // Check for low-risk safe commands
      if (
        command.startsWith("pnpm test") || 
        command.startsWith("pnpm run test") || 
        command.startsWith("vitest") ||
        command.startsWith("npm test") ||
        command.startsWith("eslint") ||
        command.startsWith("prettier") ||
        command.startsWith("pnpm build")
      ) {
        shell = 0.1;
        impact = 0.05;
      }

      if (command.includes("sudo") || command.includes("admin") || command.includes("privileged")) {
        privilege = 0.95;
      }
    }

    // 3. Network Egress Evaluation
    if (action.includes("url") || action.includes("scrape") || action.includes("web") || action.includes("fetch")) {
      network = 0.7;
      if (params.url?.includes("localhost") || params.url?.includes("127.0.0.1")) {
        network = 0.1; // safe local loopback
      }
    }

    // 3b. External/untrusted tool hint (e.g. MCP connectors). Their blast radius
    // can't be statically assessed from the action name, so floor them at MEDIUM
    // so they pass through the approval gate instead of trivially auto-approving.
    if (params.__externalTool === true) {
      network = Math.max(network, 0.5);
      impact = Math.max(impact, 0.3);
    }

    // 4. Sandbox Egress / Privileged escalation checks
    if (params.sandboxMode === "native") {
      privilege = Math.max(privilege, 0.9); // native host execution has high privilege risk
    }

    if (params.dockerNetworkDisabled === false) {
      network = Math.max(network, 0.4);
    }

    // 5. Codebase Impact calculation
    if (params.patchOperations) {
      const patchesCount = Array.isArray(params.patchOperations) ? params.patchOperations.length : 1;
      impact = Math.min(0.1 + patchesCount * 0.1, 0.9);
    }

    // Load dynamic adjustments from Heuristics ML Refiner
    try {
      const refiner = new RiskHeuristicRefiner(projectRoot);
      const adj = refiner.getAdjustments();
      
      filesystem = Math.max(0.0, Math.min(1.0, filesystem + adj.filesystem));
      shell = Math.max(0.0, Math.min(1.0, shell + adj.shell));
      network = Math.max(0.0, Math.min(1.0, network + adj.network));
      privilege = Math.max(0.0, Math.min(1.0, privilege + adj.privilege));
      destructive = Math.max(0.0, Math.min(1.0, destructive + adj.destructive));
    } catch {
      // Best-effort adjustments, fallback to raw scores if error
    }

    // Combine into overall risk score (weighted average biased towards maximum risk)
    const maxRisk = Math.max(filesystem, shell, network, privilege, destructive);
    const averageRisk = (filesystem + shell + network + privilege + impact + destructive) / 6.0;
    
    // Overall score emphasizes the worst single risk vector (maxRisk) but factors in general complexity
    const overall = parseFloat((maxRisk * 0.7 + averageRisk * 0.3).toFixed(2));

    let level: RiskLevel = "LOW";
    if (overall >= 0.7 || maxRisk >= 0.7) {
      level = "HIGH";
    } else if (overall >= 0.3 || maxRisk >= 0.3) {
      level = "MEDIUM";
    }

    return {
      filesystem: parseFloat(filesystem.toFixed(2)),
      shell: parseFloat(shell.toFixed(2)),
      network: parseFloat(network.toFixed(2)),
      privilege: parseFloat(privilege.toFixed(2)),
      impact: parseFloat(impact.toFixed(2)),
      destructive: parseFloat(destructive.toFixed(2)),
      overall,
      level,
    };
  }
}
