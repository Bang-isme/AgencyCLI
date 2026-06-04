import { describe, it, expect } from "vitest";
import { render } from "ink-testing-library";
import { Box } from "ink";
import { calculateFormattedLines } from "../components/Conversation.js";
import { getTheme, DEFAULT_THEME_ID } from "../themes/registry.js";
import type { SessionMessage } from "../state/messages.js";

const theme = getTheme(DEFAULT_THEME_ID);

function frameFor(msgs: SessionMessage[], focusedId: string | null): string {
  const lines = calculateFormattedLines(
    msgs,
    80,
    theme,
    null,
    [],
    false,
    false,
    undefined,
    false,
    focusedId
  );
  const { lastFrame } = render(
    <Box flexDirection="column">
      {lines.map((l) => (
        <Box key={l.key}>{l.element}</Box>
      ))}
    </Box>
  );
  return lastFrame() ?? "";
}

const msgs: SessionMessage[] = [
  { id: "u1", role: "user", content: "first question", timestamp: 1 },
  { id: "a1", role: "assistant", content: "first answer", timestamp: 2 },
];

describe("transcript focus highlight (AGENCY_TRANSCRIPT_NAV render)", () => {
  it("no focus → no gutter marker (legacy header path, byte-identical)", () => {
    const frame = frameFor(msgs, null);
    expect(frame).not.toContain("▎");
    expect(frame).toContain("● User");
    expect(frame).toContain("● Agent");
  });

  it("the focused message header shows the ▎ gutter; the others do not", () => {
    const frame = frameFor(msgs, "a1");
    expect(frame).toContain("▎");
    const lines = frame.split("\n");
    const agentLine = lines.find((l) => l.includes("● Agent")) ?? "";
    const userLine = lines.find((l) => l.includes("● User")) ?? "";
    expect(agentLine).toContain("▎");
    expect(userLine).not.toContain("▎");
  });
});
