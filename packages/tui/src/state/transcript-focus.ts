import type { SessionMessage } from "./messages.js";

/**
 * Transcript focus state (flag `transcriptNav`) — the keyboard-driven message
 * selection that opencode/other good CLIs offer: enter a focus mode, move a
 * highlight up/down between messages, then act on the focused one (the later
 * phases — expand / copy / fork / revert — all target this selection).
 *
 * Pure (no React/IO) so the navigation + clamping contract is unit-testable.
 * `index` is a position WITHIN the focusable list (consecutive user/assistant
 * messages), NOT an index into the raw `messages` array — so ↑/↓ step between
 * real turns and skip the interleaved `system` activity rows.
 */
export interface TranscriptFocus {
  active: boolean;
  index: number;
}

/** The inert default: focus mode off. */
export const inactiveFocus: TranscriptFocus = { active: false, index: 0 };

/**
 * The ids a focus highlight can land on, in transcript order. Only `user` and
 * `assistant` turns are focusable; `system` activity/notice rows are skipped so
 * navigation steps between real turns.
 */
export function focusableMessageIds(messages: SessionMessage[]): string[] {
  return messages
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m) => m.id);
}

/** Enter focus mode on the latest focusable message (nearest the composer). */
export function enterTranscriptFocus(messages: SessionMessage[]): TranscriptFocus {
  const ids = focusableMessageIds(messages);
  if (ids.length === 0) return inactiveFocus;
  return { active: true, index: ids.length - 1 };
}

/** Leave focus mode. */
export function exitTranscriptFocus(): TranscriptFocus {
  return inactiveFocus;
}

/**
 * Move the focus by `delta` (−1 = up/older, +1 = down/newer), clamped to the
 * focusable range. A no-op (returns the same state) when focus is inactive or
 * there is nothing focusable.
 */
export function moveTranscriptFocus(
  focus: TranscriptFocus,
  messages: SessionMessage[],
  delta: number
): TranscriptFocus {
  if (!focus.active) return focus;
  const ids = focusableMessageIds(messages);
  if (ids.length === 0) return inactiveFocus;
  const max = ids.length - 1;
  const next = Math.min(max, Math.max(0, focus.index + delta));
  return next === focus.index ? focus : { active: true, index: next };
}

/**
 * The id of the currently-focused message, or `null` when focus is inactive /
 * the list is empty. The index is clamped, so it stays valid even if messages
 * were appended/removed since focus was entered.
 */
export function focusedMessageId(
  focus: TranscriptFocus,
  messages: SessionMessage[]
): string | null {
  if (!focus.active) return null;
  const ids = focusableMessageIds(messages);
  if (ids.length === 0) return null;
  const idx = Math.min(ids.length - 1, Math.max(0, focus.index));
  return ids[idx] ?? null;
}
