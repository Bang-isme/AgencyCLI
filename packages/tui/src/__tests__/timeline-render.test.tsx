import { describe, it, expect, afterEach } from "vitest";
import { render } from "ink-testing-library";
import { Box } from "ink";
import { calculateFormattedLines } from "../components/Conversation.js";
import { getTheme, DEFAULT_THEME_ID } from "../themes/registry.js";
import type { SessionMessage } from "../state/messages.js";

const theme = getTheme(DEFAULT_THEME_ID);

function frameFor(msgs: SessionMessage[]): string {
  const lines = calculateFormattedLines(msgs, 80, theme, null, [], false, false, undefined, false);
  const { lastFrame } = render(
    <Box flexDirection="column">
      {lines.map((l) => (
        <Box key={l.key}>{l.element}</Box>
      ))}
    </Box>
  );
  return lastFrame() ?? "";
}

describe("unified ordered timeline render (AGENCY_TIMELINE_PARTS)", () => {
  const prev = process.env.AGENCY_TIMELINE_PARTS;
  const prevAnim = process.env.AGENCY_TUI_ANIMATIONS;
  afterEach(() => {
    if (prev === undefined) delete process.env.AGENCY_TIMELINE_PARTS;
    else process.env.AGENCY_TIMELINE_PARTS = prev;
    if (prevAnim === undefined) delete process.env.AGENCY_TUI_ANIMATIONS;
    else process.env.AGENCY_TUI_ANIMATIONS = prevAnim;
  });

  it("flag ON: tool activity renders CONCISE (no verbatim [SYSTEM:]) and in text→tool→text order", () => {
    process.env.AGENCY_TIMELINE_PARTS = "1";
    process.env.AGENCY_TUI_ANIMATIONS = "0";
    const frame = frameFor([
      {
        id: "tl-render-1",
        role: "assistant",
        timestamp: 1,
        content:
          'Starting work.\n⚡ [SYSTEM: Executing tool "write_file" on src/auth.ts...]\nDone here.',
      },
    ]);
    // The raw [SYSTEM:] framing must NOT be dumped verbatim — it renders concisely.
    expect(frame).not.toContain("[SYSTEM:");
    // The tool's target still shows, and the surrounding prose stays in order.
    expect(frame).toContain("auth.ts");
    expect(frame).toContain("Starting work.");
    expect(frame).toContain("Done here.");
    expect(frame.indexOf("Starting work.")).toBeLessThan(frame.indexOf("auth.ts"));
    expect(frame.indexOf("auth.ts")).toBeLessThan(frame.indexOf("Done here."));
  });

  it("flag OFF: legacy render path still produces output (byte-identical path untouched)", () => {
    process.env.AGENCY_TIMELINE_PARTS = "0";
    process.env.AGENCY_TUI_ANIMATIONS = "0";
    const frame = frameFor([
      {
        id: "tl-render-2",
        role: "assistant",
        timestamp: 1,
        content: 'Text body.\n⚡ [SYSTEM: Executing tool "write_file" on src/b.ts...]',
      },
    ]);
    expect(frame.length).toBeGreaterThan(0);
    expect(frame).toContain("Text body.");
  });
});
