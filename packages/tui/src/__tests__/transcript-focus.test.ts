import { describe, it, expect } from "vitest";
import {
  inactiveFocus,
  focusableMessageIds,
  enterTranscriptFocus,
  exitTranscriptFocus,
  moveTranscriptFocus,
  focusedMessageId,
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
});
