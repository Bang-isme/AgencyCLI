import { describe, it, expect } from "vitest";
import { render } from "ink-testing-library";
import { PromptComposer } from "../components/PromptComposer.js";
import { TerminalLayoutProvider } from "../layout/TerminalLayoutProvider.js";
import { getTheme, DEFAULT_THEME_ID } from "../themes/registry.js";

const theme = getTheme(DEFAULT_THEME_ID);
const CURSOR = "▌";
const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

/**
 * Render-level wiring check for cursor-editing mode: the block cursor must sit
 * at `cursorPos` (not pinned to the end), while the legacy path (no cursorPos)
 * keeps the end-pinned caret byte-for-byte.
 */
describe("PromptComposer caret rendering", () => {
  it("renders the block cursor at the caret column in cursor-editing mode", () => {
    const { lastFrame } = render(
      <TerminalLayoutProvider>
        <PromptComposer theme={theme} value="hello" cursorPos={2} />
      </TerminalLayoutProvider>,
    );
    expect(stripAnsi(lastFrame()!)).toContain(`he${CURSOR}llo`);
  });

  it("pins the caret to the end in legacy mode (no cursorPos)", () => {
    const { lastFrame } = render(
      <TerminalLayoutProvider>
        <PromptComposer theme={theme} value="hello" />
      </TerminalLayoutProvider>,
    );
    const f = stripAnsi(lastFrame()!);
    expect(f).toContain(`hello${CURSOR}`);
    expect(f).not.toContain(`he${CURSOR}llo`);
  });

  it("shows no caret when the composer is blurred", () => {
    const { lastFrame } = render(
      <TerminalLayoutProvider>
        <PromptComposer theme={theme} value="hello" cursorPos={2} focused={false} />
      </TerminalLayoutProvider>,
    );
    expect(stripAnsi(lastFrame()!)).not.toContain(CURSOR);
  });
});
