import { describe, expect, it } from "vitest";
import { formatSystemNotice } from "../../components/SystemNotice.js";

describe("formatSystemNotice", () => {
  it("replaces bulky help dumps with a short hint", () => {
    const out = formatSystemNotice(
      "Slash commands:\n  /help /exit /new\nShortcuts: Ctrl+P palette\n/doctor"
    );
    expect(out).toContain("? for help");
    expect(out).not.toContain("/doctor");
  });

  it("keeps short non-help system lines", () => {
    expect(formatSystemNotice("Indexed 42 files → .agency/index.json")).toBe(
      "Indexed 42 files → .agency/index.json"
    );
  });
});
