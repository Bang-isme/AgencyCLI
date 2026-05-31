import { describe, expect, it } from "vitest";
import { SecurityLevel, SecurityEscalationManager } from "../security-escalation.js";

describe("SecurityEscalationManager", () => {
  it("should resolve correct security levels for known tools", () => {
    const manager = new SecurityEscalationManager();
    expect(manager.getToolLevel("math")).toBe(SecurityLevel.Level1_Safe);
    expect(manager.getToolLevel("view_file")).toBe(SecurityLevel.Level2_ReadOnly);
    expect(manager.getToolLevel("write_to_file")).toBe(SecurityLevel.Level3_WorkspaceWrite);
    expect(manager.getToolLevel("search_web")).toBe(SecurityLevel.Level4_Network);
    expect(manager.getToolLevel("run_command")).toBe(SecurityLevel.Level5_Privileged);
  });

  it("should enforce capability boundaries", () => {
    const manager = new SecurityEscalationManager();
    
    // View file (Level 2) is allowed under Level 2 max capability
    let check = manager.checkAccess("view_file", SecurityLevel.Level2_ReadOnly);
    expect(check.allowed).toBe(true);

    // Run command (Level 5) is NOT allowed under Level 2 max capability
    check = manager.checkAccess("run_command", SecurityLevel.Level2_ReadOnly);
    expect(check.allowed).toBe(false);
    expect(check.reason).toContain("requires Level 5 capability");
  });

  it("should allow whitelisted tools to bypass checks", () => {
    const manager = new SecurityEscalationManager();
    const whitelist = new Set(["run_command"]);

    // Run command (Level 5) is allowed if whitelisted, even if maxAllowed is Level 2
    const check = manager.checkAccess("run_command", SecurityLevel.Level2_ReadOnly, whitelist);
    expect(check.allowed).toBe(true);
  });
});
