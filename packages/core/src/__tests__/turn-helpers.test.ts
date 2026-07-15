import { describe, it, expect, afterEach } from "vitest";
import { resolveSessionId } from "../chat/turn-helpers.js";

describe("resolveSessionId (cross-session recall fix)", () => {
  const prev = process.env.AGENCY_SESSION_ID;
  afterEach(() => {
    if (prev === undefined) delete process.env.AGENCY_SESSION_ID;
    else process.env.AGENCY_SESSION_ID = prev;
  });

  it("prefers an explicit session id over everything", () => {
    process.env.AGENCY_SESSION_ID = "from-env";
    expect(resolveSessionId("explicit-id")).toBe("explicit-id");
  });

  it("falls back to AGENCY_SESSION_ID when no explicit id is given", () => {
    process.env.AGENCY_SESSION_ID = "env-session";
    expect(resolveSessionId()).toBe("env-session");
    expect(resolveSessionId(undefined)).toBe("env-session");
  });

  it("generates a unique, stable per-process fallback (not the old constant 'sess-cli')", () => {
    delete process.env.AGENCY_SESSION_ID;
    const a = resolveSessionId();
    const b = resolveSessionId();
    // The old constant collapsed every CLI run onto one id, defeating the
    // `session_id != current` cross-session recall filter.
    expect(a).not.toBe("sess-cli");
    expect(a.startsWith("sess-cli-")).toBe(true);
    // Stable within the process so multiple turns of one run share it…
    expect(b).toBe(a);
    // …but it is a real unique id, not the bare constant.
    expect(a.length).toBeGreaterThan("sess-cli-".length);
  });
});

import { detectIncompleteCompletion } from "../chat/turn-helpers.js";

describe("detectIncompleteCompletion (autoContinue nudge for unfulfilled intent)", () => {
  it("detects unfulfilled tool execution intent in Vietnamese prose", () => {
    expect(detectIncompleteCompletion("Giờ chạy dev server.")).toBe(true);
    expect(detectIncompleteCompletion("File đang có framer-motion import. Dùng batch_edit để fix tất cả cùng lúc. Build thành công! Giờ chạy dev server.")).toBe(true);
  });

  it("detects unfulfilled tool execution intent in thinking blocks (<thought>)", () => {
    const text = "<thought>Let me just run the dev server command - it seems like the previous command didn't actually start the dev server or the response got cut off. Let me start it now.</thought>";
    expect(detectIncompleteCompletion(text)).toBe(true);
  });

  it("does not trip on questions or offers to the user", () => {
    expect(detectIncompleteCompletion("Would you like me to run the dev server now?")).toBe(false);
    expect(detectIncompleteCompletion("Let me know if you want me to start the server.")).toBe(false);
  });
});
