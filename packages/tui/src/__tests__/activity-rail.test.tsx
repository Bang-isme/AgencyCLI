import { describe, expect, it } from "vitest";
import { render } from "ink-testing-library";
import { ActivityRail, type RuntimeActivity } from "../components/ActivityRail.js";
import { ToolActivity } from "../components/ToolActivity.js";
import { DEFAULT_THEME_ID, getTheme } from "../themes/registry.js";
import { lifecycleFromToolEvent } from "@agency/core";

const theme = getTheme(DEFAULT_THEME_ID);

describe("ActivityRail", () => {
  it("renders semantic runtime activities from structured events", () => {
    const activities: RuntimeActivity[] = [
      {
        id: "1",
        name: "write_file",
        action: "write",
        target: "src/App.tsx",
        status: "done",
        summary: "1.7 KB",
        startedAt: Date.now(),
        agentId: "main",
      },
      {
        id: "2",
        name: "execute_command",
        action: "exec",
        target: "pnpm test",
        status: "done",
        summary: "exit 0",
        durationMs: 1250,
        startedAt: Date.now(),
        agentId: "main",
      },
    ];

    const { lastFrame } = render(
      <ActivityRail theme={theme} activities={activities} />
    );
    const frame = lastFrame() ?? "";

    expect(frame).toContain("Activity");
    expect(frame).toContain("Wrote App.tsx");
    expect(frame).toContain("Ran pnpm test");
    expect(frame).toContain("exit 0");
    expect(frame).not.toContain("exec · write");
  });

  it("keeps the primary loading row separate from the recent activity rail", () => {
    const { lastFrame } = render(
      <>
        <ToolActivity
          theme={theme}
          active
          phase="writing"
          startMs={Date.now()}
          label="Write WishlistProvider.tsx"
        />
        <ActivityRail
          theme={theme}
          activities={[
            {
              id: "1",
              name: "write_file",
              action: "write",
              target: "src/WishlistProvider.tsx",
              status: "done",
              summary: "1.7 KB",
              durationMs: 6,
              startedAt: Date.now(),
              agentId: "main",
            },
          ]}
        />
      </>
    );
    const frame = lastFrame() ?? "";

    expect(frame).toContain("Write WishlistProvider.tsx");
    expect(frame).toContain("Activity");
    expect(frame).toContain("Wrote WishlistProvider.tsx");
  });

  it("does not duplicate the active tool shown by ToolActivity", () => {
    const { lastFrame } = render(
      <ActivityRail
        theme={theme}
        activities={[
          {
            id: "active",
            name: "write_file",
            action: "write",
            target: "src/Active.tsx",
            status: "active",
            startedAt: Date.now(),
            agentId: "main",
          },
        ]}
      />
    );

    expect((lastFrame() ?? "").trim()).toBe("");
  });

  it("uses the shared lifecycle label instead of a raw process target", () => {
    const lifecycle = lifecycleFromToolEvent("succeeded", {
      name: "execute_command",
      target: "OpenJS.NodeJS.22_Microsoft.Winget.Source_8we",
      summary: "exit 0",
    });
    const { lastFrame } = render(
      <ActivityRail
        theme={theme}
        activities={[{
          id: "shell", name: "execute_command", action: "exec", target: lifecycle.target ?? "", status: "done",
          summary: "exit 0", startedAt: Date.now(), lifecycle,
        }]}
      />
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Run command");
    expect(frame).not.toContain("OpenJS.NodeJS.22_Microsoft.Winget.Source_8we");
  });
});
