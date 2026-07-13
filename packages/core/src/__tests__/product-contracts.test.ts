import { describe, expect, it } from "vitest";
import {
  findCapability,
  lifecycleFromToolEvent,
  listCapabilities,
  capabilityRegistry,
  CapabilityRegistry,
} from "../index.js";

describe("product capability and lifecycle contracts", () => {
  it("keeps the daily TUI surface small while retaining advanced capabilities", () => {
    const core = listCapabilities("tui", "core");
    const advanced = listCapabilities("tui", "advanced");
    expect(core.map((item) => item.id)).toContain("review");
    expect(core.map((item) => item.id)).not.toContain("mcp");
    expect(advanced.map((item) => item.id)).toContain("mcp");
    expect(findCapability("sessions")?.description).toContain("Resume");
  });

  it("presents structured tool events without leaking a raw process title", () => {
    const event = lifecycleFromToolEvent("running", {
      name: "execute_command",
      target: "OpenJS.NodeJS.22_Microsoft.Winget.Source_8we",
    }, 100);
    expect(event.label).toBe("Run command");
    expect(event.rawDetail).toBeUndefined();
    expect(event.state).toBe("running");
  });

  it("adds a recovery message to incomplete actions", () => {
    const event = lifecycleFromToolEvent("incomplete", { name: "dispatch_subagent" }, 100);
    expect(event.recovery).toContain("retry or resume");
  });

  it("supports dynamic registration, filtering, aliases, and prerequisites in CapabilityRegistry", async () => {
    const registry = new CapabilityRegistry();
    registry.register({
      id: "test_cap",
      tier: "advanced",
      surfaces: ["tui", "cli"],
      label: "Test Capability",
      description: "A test capability",
      category: "extension",
      risk: "medium",
      prerequisites: ["git_repo"],
      recoveryAction: "Run test setup",
      icon: "🧪",
      aliases: ["tcap"],
    });

    expect(registry.has("test_cap")).toBe(true);
    expect(registry.has("tcap")).toBe(true);
    expect(registry.get("tcap")?.id).toBe("test_cap");

    const filtered = registry.list({ surface: "tui", maxRisk: "high", query: "Capability" });
    expect(filtered.length).toBe(1);
    expect(filtered[0]?.icon).toBe("🧪");

    const toolCap = registry.registerToolDefinition("custom_tool", "Custom tool description", "tool", "high");
    expect(toolCap.id).toBe("custom_tool");
    expect(registry.get("custom_tool")?.surfaces).toContain("tool");

    const prereqResult = await registry.checkPrerequisites("test_cap", process.cwd());
    expect(typeof prereqResult.satisfied).toBe("boolean");

    expect(registry.unregister("tcap")).toBe(true);
    expect(registry.has("test_cap")).toBe(false);
  });
});

