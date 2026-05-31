export enum SecurityLevel {
  Level1_Safe = 1,          // Math, status, counter
  Level2_ReadOnly = 2,      // File read, list dir, grep
  Level3_WorkspaceWrite = 3,// File write, patch, delete
  Level4_Network = 4,       // Web search, scraping, api requests
  Level5_Privileged = 5,    // Terminal commands, Docker shell
}

export interface SecurityCheckResult {
  allowed: boolean;
  toolLevel: SecurityLevel;
  reason?: string;
}

export class SecurityEscalationManager {
  private toolLevelRegistry: Map<string, SecurityLevel> = new Map([
    // Level 1: Safe operations
    ["math", SecurityLevel.Level1_Safe],
    ["status", SecurityLevel.Level1_Safe],
    ["list_permissions", SecurityLevel.Level1_Safe],

    // Level 2: Read-only operations
    ["view_file", SecurityLevel.Level2_ReadOnly],
    ["list_dir", SecurityLevel.Level2_ReadOnly],
    ["grep_search", SecurityLevel.Level2_ReadOnly],
    ["list_resources", SecurityLevel.Level2_ReadOnly],
    ["read_resource", SecurityLevel.Level2_ReadOnly],

    // Level 3: Workspace write operations
    ["write_to_file", SecurityLevel.Level3_WorkspaceWrite],
    ["replace_file_content", SecurityLevel.Level3_WorkspaceWrite],
    ["multi_replace_file_content", SecurityLevel.Level3_WorkspaceWrite],

    // Level 4: Network operations
    ["read_url_content", SecurityLevel.Level4_Network],
    ["search_web", SecurityLevel.Level4_Network],
    ["execute_url", SecurityLevel.Level4_Network],

    // Level 5: Privileged execution
    ["run_command", SecurityLevel.Level5_Privileged],
  ]);

  /**
   * Gets the security level mapping for a tool name.
   */
  getToolLevel(toolName: string): SecurityLevel {
    const level = this.toolLevelRegistry.get(toolName);
    if (level !== undefined) return level;
    
    // Default fallback rules:
    if (toolName.includes("write") || toolName.includes("patch") || toolName.includes("delete") || toolName.includes("edit")) {
      return SecurityLevel.Level3_WorkspaceWrite;
    }
    if (toolName.includes("read") || toolName.includes("get") || toolName.includes("view") || toolName.includes("list")) {
      return SecurityLevel.Level2_ReadOnly;
    }
    if (toolName.includes("run") || toolName.includes("exec") || toolName.includes("command") || toolName.includes("shell")) {
      return SecurityLevel.Level5_Privileged;
    }
    
    return SecurityLevel.Level3_WorkspaceWrite; // Safe default for unmapped actions
  }

  /**
   * Check if a tool execution is allowed under current capabilities and session whitelist.
   */
  checkAccess(
    toolName: string,
    maxAllowedLevel: SecurityLevel,
    whitelist: Set<string> = new Set()
  ): SecurityCheckResult {
    const level = this.getToolLevel(toolName);

    // Whitelisted tools always bypass
    if (whitelist.has(toolName)) {
      return { allowed: true, toolLevel: level };
    }

    if (level <= maxAllowedLevel) {
      return { allowed: true, toolLevel: level };
    }

    return {
      allowed: false,
      toolLevel: level,
      reason: `Tool '${toolName}' requires Level ${level} capability, but current maximum allowed level is Level ${maxAllowedLevel}. Authorization required.`,
    };
  }
}
