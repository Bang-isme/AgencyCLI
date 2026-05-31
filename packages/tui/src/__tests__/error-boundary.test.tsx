import { describe, expect, it, afterEach } from "vitest";
import { render } from "ink-testing-library";
import { Text } from "ink";
import { rmSync } from "node:fs";
import { AppErrorBoundary } from "../components/AppErrorBoundary.js";

function Boom(): never {
  throw new Error("boom-render-failure");
}

describe("AppErrorBoundary", () => {
  afterEach(() => {
    try {
      rmSync(".agency/crash.log", { force: true });
    } catch {
      /* ignore */
    }
  });

  it("renders a calm fallback instead of unmounting the tree when a child throws", () => {
    // A render throw without a boundary unmounts the App → Ink waitUntilExit
    // resolves → launcher leaves the alt screen and exits = "văng ra shell".
    const { lastFrame, unmount } = render(
      <AppErrorBoundary>
        <Boom />
      </AppErrorBoundary>
    );

    const frame = lastFrame() ?? "";
    expect(frame).toContain("render error");
    expect(frame).toContain("boom-render-failure");
    unmount();
  });

  it("passes healthy children straight through", () => {
    const { lastFrame, unmount } = render(
      <AppErrorBoundary>
        <Text>healthy-content</Text>
      </AppErrorBoundary>
    );

    expect(lastFrame()).toContain("healthy-content");
    unmount();
  });
});
