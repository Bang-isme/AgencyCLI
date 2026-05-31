import { describe, expect, it } from "vitest";
import { sanitizeSessionMessages } from "../sessions/sanitize.js";

describe("sanitizeSessionMessages", () => {
  it("removes legacy help dumps from system messages", () => {
    const out = sanitizeSessionMessages([
      {
        id: "1",
        role: "system",
        content:
          "Slash commands:\n  /help /exit\nShortcuts: Ctrl+P palette\n/doctor /route",
        timestamp: 1,
      },
      {
        id: "2",
        role: "user",
        content: "hi",
        timestamp: 2,
      },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]?.role).toBe("user");
  });
});
