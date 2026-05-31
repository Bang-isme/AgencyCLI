import { describe, expect, it, afterEach } from "vitest";
import { z } from "zod";
import { RiskAssessor } from "../approval/risk-assessor.js";
import { executeTool, registry as toolRegistry, toolApprovalEngine } from "../skill/tool-harness.js";

describe("RiskAssessor external-tool hint", () => {
  it("rates an arbitrary tool name LOW without the hint", () => {
    const risk = RiskAssessor.assessRisk("slack_send_message", {});
    expect(risk.level).toBe("LOW");
  });

  it("floors an external (MCP) tool at MEDIUM so it passes through the gate", () => {
    const risk = RiskAssessor.assessRisk("slack_send_message", { __externalTool: true });
    expect(risk.level).not.toBe("LOW");
    expect(risk.network).toBeGreaterThanOrEqual(0.5);
  });
});

describe("MCP tools in the approval gate", () => {
  const ENV = "AGENCY_APPROVAL_IN_TOOLPATH";

  afterEach(() => {
    delete process.env[ENV];
    toolApprovalEngine.setMode("Balanced");
    toolApprovalEngine.resetInterruptionCount();
    // The registry is a module singleton; drop the fakes we registered.
    (toolRegistry as any).tools?.delete?.("fakemcp_send");
  });

  function registerFakeMcpTool() {
    toolRegistry.register({
      name: "fakemcp_send",
      description: "fake MCP tool",
      category: "other",
      schema: z.record(z.any()),
      execute: async () => "MCP_OK",
      // The marker the MCP client attaches; the gate keys off this.
      mcpSchema: { type: "object" },
    } as any);
  }

  it("blocks an MCP tool in enforce mode under Safe autonomy", async () => {
    registerFakeMcpTool();
    process.env[ENV] = "enforce";
    toolApprovalEngine.setMode("Safe");
    const out = await executeTool("fakemcp_send", { channel: "#x", text: "hi" }, process.cwd());
    expect(out).toMatch(/Approval required/i);
    expect(out).not.toContain("MCP_OK");
  });

  it("does not block in warn mode (observe-only)", async () => {
    registerFakeMcpTool();
    process.env[ENV] = "warn";
    toolApprovalEngine.setMode("Safe");
    const out = await executeTool("fakemcp_send", { channel: "#x", text: "hi" }, process.cwd());
    expect(out).toBe("MCP_OK");
  });

  it("does not block when gating is off", async () => {
    registerFakeMcpTool();
    process.env[ENV] = "off";
    toolApprovalEngine.setMode("Safe");
    const out = await executeTool("fakemcp_send", { channel: "#x", text: "hi" }, process.cwd());
    expect(out).toBe("MCP_OK");
  });
});
