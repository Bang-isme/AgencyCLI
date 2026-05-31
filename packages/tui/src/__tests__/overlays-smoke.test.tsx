import { describe, expect, it } from "vitest";
import { render } from "ink-testing-library";
import { getTheme, DEFAULT_THEME_ID } from "../themes/registry.js";
import { ModelsOverlay } from "../components/ModelsOverlay.js";
import { SessionPicker } from "../components/SessionPicker.js";
import { StatusDashboard } from "../components/StatusDashboard.js";
import { ReviewMenu } from "../components/ReviewMenu.js";
import { VariantOverlay } from "../components/VariantOverlay.js";
import { McpOverlay } from "../components/McpOverlay.js";
import { PluginsOverlay } from "../components/PluginsOverlay.js";
import { SubagentsOverlay } from "../components/SubagentsOverlay.js";
import { join } from "node:path";
import { tmpdir } from "node:os";

const theme = getTheme(DEFAULT_THEME_ID);
const noop = () => {};
const MISSING = join(tmpdir(), "agency-no-such-dir-xyz");

/**
 * Empty-data render smoke: overlays must not crash when their lists are empty
 * (a brand-new session, no models loaded yet, no past sessions, etc.).
 */
describe("overlay empty-state smoke", () => {
  it("ModelsOverlay renders with an empty model list", () => {
    const { lastFrame } = render(
      <ModelsOverlay theme={theme} models={[]} loading={false} onSelect={noop} onClose={noop} />
    );
    expect(typeof lastFrame()).toBe("string");
  });

  it("ModelsOverlay renders while loading", () => {
    const { lastFrame } = render(
      <ModelsOverlay theme={theme} models={[]} loading onSelect={noop} onClose={noop} />
    );
    expect(typeof lastFrame()).toBe("string");
  });

  it("SessionPicker renders with no sessions", () => {
    const { lastFrame } = render(
      <SessionPicker
        theme={theme}
        sessions={[]}
        index={0}
        setIndex={noop}
        setDeletingId={noop}
        onSelect={noop}
        onClose={noop}
      />
    );
    expect(typeof lastFrame()).toBe("string");
  });

  it("StatusDashboard renders with no providers", () => {
    const { lastFrame } = render(
      <StatusDashboard theme={theme} providers={[]} onClose={noop} />
    );
    expect(typeof lastFrame()).toBe("string");
  });

  it("ReviewMenu renders its action list", () => {
    const { lastFrame } = render(
      <ReviewMenu theme={theme} onSelect={noop} onClose={noop} />
    );
    expect(typeof lastFrame()).toBe("string");
  });

  it("VariantOverlay renders with no variants", () => {
    const modelSpec = {
      contextWindow: 128000,
      maxOutputTokens: 8192,
      thinkingType: "none",
      supported: false,
    } as any;
    const { lastFrame } = render(
      <VariantOverlay
        theme={theme}
        modelName="gpt-4o-mini"
        providerId="openai"
        modelSpec={modelSpec}
        variants={[]}
        currentThinking={undefined}
        onSelect={noop}
        onClose={noop}
      />
    );
    expect(typeof lastFrame()).toBe("string");
  });

  it("McpOverlay renders for a project with no mcp config", () => {
    const { lastFrame } = render(
      <McpOverlay theme={theme} projectRoot={MISSING} onClose={noop} onReload={noop} />
    );
    expect(typeof lastFrame()).toBe("string");
  });

  it("PluginsOverlay renders for a missing skills root", () => {
    const { lastFrame } = render(
      <PluginsOverlay theme={theme} skillsRoot={MISSING} onClose={noop} />
    );
    expect(typeof lastFrame()).toBe("string");
  });

  it("SubagentsOverlay renders for a project with no dispatch history", () => {
    const { lastFrame } = render(
      <SubagentsOverlay theme={theme} project={MISSING} onClose={noop} />
    );
    expect(typeof lastFrame()).toBe("string");
  });
});
