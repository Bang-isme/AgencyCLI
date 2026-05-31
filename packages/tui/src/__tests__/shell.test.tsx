import { describe, expect, it } from "vitest";
import { render } from "ink-testing-library";
import { Text } from "ink";
import { Shell } from "../layout/Shell.js";
import { getTheme, DEFAULT_THEME_ID } from "../themes/registry.js";

const theme = getTheme(DEFAULT_THEME_ID);

describe("Shell", () => {
  it("renders header, body, and footer", () => {
    const { lastFrame } = render(
      <Shell
        theme={theme}
        project="AgencyCLI"
        footer={<Text>footer</Text>}
      >
        <Text>main content</Text>
      </Shell>
    );

    const frame = lastFrame();
    expect(frame).toContain("acg");
    expect(frame).toContain("AgencyCLI");
    expect(frame).toContain("main content");
    expect(frame).toContain("footer");
  });
});
