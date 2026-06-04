import { describe, it, expect } from "vitest";
import {
  inactiveFocus,
  focusableMessageIds,
  enterTranscriptFocus,
  exitTranscriptFocus,
  moveTranscriptFocus,
  focusedMessageId,
  scrollOffsetForFocus,
} from "../state/transcript-focus.js";
import type { SessionMessage } from "../state/messages.js";

const msg = (id: string, role: SessionMessage["role"]): SessionMessage => ({
  id,
  role,
  content: id,
  timestamp: 1,
});

// A transcript with interleaved system activity between real turns.
const transcript: SessionMessage[] = [
  msg("u1", "user"),
  msg("sys1", "system"),
  msg("a1", "assistant"),
  msg("sys2", "system"),
  msg("u2", "user"),
  msg("a2", "assistant"),
];

describe("transcript-focus (P2 nav)", () => {
  it("focusable list skips system rows, keeps transcript order", () => {
    expect(focusableMessageIds(transcript)).toEqual(["u1", "a1", "u2", "a2"]);
  });

  it("enter focuses the latest focusable message (nearest the composer)", () => {
    const f = enterTranscriptFocus(transcript);
    expect(f.active).toBe(true);
    expect(focusedMessageId(f, transcript)).toBe("a2");
  });

  it("enter on an empty / system-only transcript stays inactive", () => {
    expect(enterTranscriptFocus([])).toEqual(inactiveFocus);
    expect(enterTranscriptFocus([msg("s", "system")])).toEqual(inactiveFocus);
  });

  it("up/down steps between turns and clamps at both ends", () => {
    let f = enterTranscriptFocus(transcript); // a2
    f = moveTranscriptFocus(f, transcript, -1);
    expect(focusedMessageId(f, transcript)).toBe("u2");
    f = moveTranscriptFocus(f, transcript, -1);
    expect(focusedMessageId(f, transcript)).toBe("a1");
    f = moveTranscriptFocus(f, transcript, -1);
    expect(focusedMessageId(f, transcript)).toBe("u1");
    // clamp at the top
    const top = moveTranscriptFocus(f, transcript, -1);
    expect(top).toBe(f); // no-op returns same reference
    expect(focusedMessageId(top, transcript)).toBe("u1");
    // back down, then clamp at the bottom
    let g = moveTranscriptFocus(top, transcript, 1);
    expect(focusedMessageId(g, transcript)).toBe("a1");
    g = enterTranscriptFocus(transcript);
    expect(moveTranscriptFocus(g, transcript, 1)).toBe(g); // already bottom
  });

  it("move is a no-op when focus is inactive", () => {
    expect(moveTranscriptFocus(inactiveFocus, transcript, -1)).toBe(inactiveFocus);
  });

  it("exit clears focus; focusedMessageId is null when inactive", () => {
    expect(exitTranscriptFocus()).toEqual(inactiveFocus);
    expect(focusedMessageId(inactiveFocus, transcript)).toBeNull();
  });

  it("focused id stays valid (clamped) if messages shrank since entering", () => {
    const f = enterTranscriptFocus(transcript); // index 3 (a2)
    const shrunk = [msg("u1", "user"), msg("a1", "assistant")];
    // index 3 is now out of range → clamps to the last focusable
    expect(focusedMessageId(f, shrunk)).toBe("a1");
  });

  describe("scrollOffsetForFocus (auto-scroll windowing)", () => {
    it("leaves the offset alone when the line is already visible", () => {
      // window [10, 19] (height 10) — line 14 is inside
      expect(scrollOffsetForFocus(14, 10, 10)).toBe(10);
      expect(scrollOffsetForFocus(10, 10, 10)).toBe(10); // top edge
      expect(scrollOffsetForFocus(19, 10, 10)).toBe(10); // bottom edge
    });

    it("scrolls up to the line when it is above the window", () => {
      expect(scrollOffsetForFocus(3, 10, 10)).toBe(3);
    });

    it("scrolls down (1-line bottom margin) when below the window", () => {
      // line 25, window height 10 → offset 25 - 10 + 2 = 17 → window [17, 26]
      expect(scrollOffsetForFocus(25, 10, 10)).toBe(17);
    });

    it("never returns a negative offset and tolerates a tiny viewport", () => {
      expect(scrollOffsetForFocus(0, 0, 1)).toBe(0);
      expect(scrollOffsetForFocus(5, 0, 0)).toBeGreaterThanOrEqual(0);
    });

    it("returns the previous offset for a missing line (idx < 0)", () => {
      expect(scrollOffsetForFocus(-1, 7, 10)).toBe(7);
    });
  });
});
