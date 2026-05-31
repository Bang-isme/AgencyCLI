import { describe, expect, it } from "vitest";
import { resolveTuiLaunch } from "../tui-launch.js";

describe("resolveTuiLaunch", () => {
  it("launches TUI with no args", () => {
    expect(resolveTuiLaunch(["node", "agency"])).toEqual({ launch: true });
  });

  it("launches TUI for acg with project path", () => {
    const plan = resolveTuiLaunch(["node", "acg", "D:\\AgencyCLI"]);
    expect(plan.launch).toBe(true);
    expect(plan.project).toContain("AgencyCLI");
  });

  it("does not launch TUI for known subcommands", () => {
    expect(resolveTuiLaunch(["node", "agency", "doctor"]).launch).toBe(false);
    expect(resolveTuiLaunch(["node", "agency", "chat", "hi"]).launch).toBe(
      false
    );
  });

  it("launches TUI when sole arg is a project path", () => {
    const plan = resolveTuiLaunch(["node", "agency", "."]);
    expect(plan.launch).toBe(true);
    expect(plan.project).toBeTruthy();
  });
});
