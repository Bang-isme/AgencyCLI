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

  it("/thinking changes thinkingMode", async () => {
    const showResult = await executeSlash("/thinking show", {
      projectRoot: "/proj",
      themeId: "agency",
    });
    expect(showResult.handled).toBe(true);
    expect(showResult.thinkingMode).toBe("show");
    expect(showResult.systemLines).toEqual(["Thinking mode set to show."]);

    const hideResult = await executeSlash("/thinking hide", {
      projectRoot: "/proj",
      themeId: "agency",
    });
    expect(hideResult.handled).toBe(true);
    expect(hideResult.thinkingMode).toBe("hide");
    expect(hideResult.systemLines).toEqual(["Thinking mode set to hide."]);

    const invalidResult = await executeSlash("/thinking invalid", {
      projectRoot: "/proj",
      themeId: "agency",
    });
    expect(invalidResult.handled).toBe(true);
    expect(invalidResult.thinkingMode).toBeUndefined();
    expect(invalidResult.systemLines).toEqual(["Usage: /thinking <show|hide>"]);
  });

  it("/toggle-thinking toggles thinkingMode", async () => {
    const result = await executeSlash("/toggle-thinking", {
      projectRoot: "/proj",
      themeId: "agency",
    });
    expect(result.handled).toBe(true);
    expect(result.toggleThinkingMode).toBe(true);
  });
});

