import React from "react";
import { describe, expect, it, vi } from "vitest";
import { render } from "ink-testing-library";
import { LiveGrillOverlay } from "../components/LiveGrillOverlay.js";
import { THEMES } from "../themes/registry.js";
import { EventBus } from "@agency/core";

describe("LiveGrillOverlay", () => {
  const theme = THEMES.agency!;

  it("renders menu options and failures count", () => {
    const payload = {
      consecutiveFailures: 5,
      lastModifiedFiles: ["src/App.tsx"],
    };

    const { lastFrame } = render(
      <LiveGrillOverlay theme={theme} payload={payload} onClose={() => {}} />
    );

    const frame = lastFrame() ?? "";
    expect(frame).toContain("Stuck Agent Detected");
    expect(frame).toContain("5");
    expect(frame).toContain("App.tsx");
    expect(frame).toContain("[C] Steer");
    expect(frame).toContain("[R] Rollback");
    expect(frame).toContain("[A] Abort");
  });

  it("switches to input phase when C is pressed", async () => {
    const payload = {
      consecutiveFailures: 5,
    };

    const { stdin, lastFrame } = render(
      <LiveGrillOverlay theme={theme} payload={payload} onClose={() => {}} />
    );

    // Wait for mount
    await new Promise((r) => setTimeout(r, 50));

    stdin.write("c");
    await new Promise((r) => setTimeout(r, 50));

    expect(lastFrame()).toContain("Enter Steering Instructions");
  });

  it("publishes loop:resume with abort action when A is pressed", async () => {
    const payload = {
      consecutiveFailures: 5,
      agentId: "my-agent",
      conversationId: "my-conv",
    };

    const publishSpy = vi.spyOn(EventBus.getInstance(), "publish");

    const onClose = vi.fn();
    const { stdin } = render(
      <LiveGrillOverlay theme={theme} payload={payload} onClose={onClose} />
    );

    await new Promise((r) => setTimeout(r, 50));

    stdin.write("a");
    await new Promise((r) => setTimeout(r, 50));

    expect(publishSpy).toHaveBeenCalledWith("loop:resume", {
      agentId: "my-agent",
      conversationId: "my-conv",
      action: "abort",
      feedback: undefined,
    });
    expect(onClose).toHaveBeenCalled();
  });
});
