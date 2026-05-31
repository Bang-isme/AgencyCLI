import { describe, expect, it } from "vitest";
import { executeSlash, parseSlashCommand } from "../slash/commands.js";

describe("slash commands", () => {
  it("parses command name and args", () => {
    expect(parseSlashCommand("/help")).toEqual({ name: "help", args: "" });
    expect(parseSlashCommand("/theme daylight")).toEqual({
      name: "theme",
      args: "daylight",
    });
  });

  it("/help opens help overlay", async () => {
    const result = await executeSlash("/help", {
      projectRoot: "/proj",
      themeId: "agency",
    });
    expect(result.handled).toBe(true);
    expect(result.showHelp).toBe(true);
    expect(result.systemLines).toBeUndefined();
  });

  it("/theme switches theme id", async () => {
    const result = await executeSlash("/theme daylight", {
      projectRoot: "/proj",
      themeId: "agency",
    });
    expect(result.themeId).toBe("daylight");
  });

  it("/exit requests exit", async () => {
    const result = await executeSlash("/exit", {
      projectRoot: "/proj",
      themeId: "agency",
    });
    expect(result.exit).toBe(true);
  });

  it("/dashboard handles dashboard command variations and routing", async () => {
    const result = await executeSlash("/dashboard", {
      projectRoot: "/non-existent-directory-xyz-123",
      themeId: "agency",
    });
    expect(result.handled).toBe(true);
    expect(result.systemLines).toBeDefined();
    expect(result.systemLines![0]).toContain("Error");
  });
});
