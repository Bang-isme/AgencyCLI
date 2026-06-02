import { describe, expect, it } from "vitest";
import { render } from "ink-testing-library";
import { ConnectOverlay, type ProviderStatus } from "../components/ConnectOverlay.js";
import { getTheme, DEFAULT_THEME_ID } from "../themes/registry.js";

const theme = getTheme(DEFAULT_THEME_ID);

const mockProviders: ProviderStatus[] = [
  { id: "google", label: "Google Gemini", icon: "💎", configured: false },
  { id: "openai", label: "OpenAI", icon: "🤖", configured: true, modelCount: 5 },
];

describe("ConnectOverlay TUI", () => {
  it("renders the providers list cleanly", () => {
    const { lastFrame } = render(
      <ConnectOverlay
        theme={theme}
        providers={mockProviders}
        onSaveKey={() => {}}
        onClose={() => {}}
      />
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Providers");
    expect(frame).toContain("Google Gemini");
    expect(frame).toContain("OpenAI");
    expect(frame).toContain("not connected");
    expect(frame).toContain("connected · 5 models");
  });
});
