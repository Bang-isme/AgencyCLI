import { describe, expect, it } from "vitest";
import { render } from "ink-testing-library";
import { Conversation } from "../components/Conversation.js";
import { getTheme, DEFAULT_THEME_ID } from "../themes/registry.js";

const theme = getTheme(DEFAULT_THEME_ID);

describe("Conversation", () => {
  it("renders conversation header and messages", () => {
    const { lastFrame } = render(
      <Conversation
        theme={theme}
        messages={[
          {
            id: "1",
            role: "user",
            content: "fix test",
            timestamp: Date.now(),
          },
        ]}
      />
    );
    const frame = lastFrame();
    expect(frame).toContain("fix test");
  });
});
