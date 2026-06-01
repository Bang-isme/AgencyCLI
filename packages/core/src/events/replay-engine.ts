import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { ReplayEvent } from "@agency/contracts";
import { EventJournal } from "./event-journal.js";

export class ReplayEngine {
  private events: ReplayEvent[] = [];
  private pointer = 0;

  constructor(events: ReplayEvent[]) {
    // Ensure events are strictly sorted by sequence ID for stable chronological replay
    this.events = [...events].sort((a, b) => a.sequenceId - b.sequenceId);
  }

  /**
   * Performs playback verification of an execution step.
   * Matches action name and hashes parameters to verify that the execution matches the logged state.
   */
  public playback(action: string, payload: any): ReplayEvent {
    if (this.pointer >= this.events.length) {
      throw new Error(
        `Replay mismatch: Execution tried to run action "${action}" but replay log is already fully consumed.`
      );
    }

    const expectedEvent = this.events[this.pointer];
    const payloadStr = typeof payload === "string" ? payload : JSON.stringify(payload);
    const actualHash = createHash("sha256").update(action + ":" + payloadStr).digest("hex");

    if (expectedEvent.action !== action) {
      throw new Error(
        `Replay mismatch at sequence ${expectedEvent.sequenceId}: Expected action "${expectedEvent.action}", but actual execution triggered "${action}".`
      );
    }

    if (expectedEvent.payloadHash !== actualHash) {
      throw new Error(
        `Replay divergence at sequence ${expectedEvent.sequenceId} (action: "${action}"): Parameter hash mismatch.\n` +
        `Expected payload: ${expectedEvent.payload}\n` +
        `Actual payload: ${payloadStr}`
      );
    }

    this.pointer++;
    return expectedEvent;
  }

  public getPointer(): number {
    return this.pointer;
  }

  public isComplete(): boolean {
    return this.pointer >= this.events.length;
  }
}

/** Outcome of replaying a recorded event journal through {@link ReplayEngine}. */
export interface JournalReplayResult {
  /** True when no divergence was found. Spilled events are skipped, not failures. */
  ok: boolean;
  /** Total events read from the journal. */
  total: number;
  /** Inline events whose `action` + `payload` still hash to the stored `payloadHash`. */
  verified: number;
  /**
   * Oversized events whose inline payload was replaced by a small ref and spilled
   * to disk (see the EventBus spill path). Their stored hash covers the *original*
   * payload, so they can't be re-verified from the inline ref — reported here
   * rather than silently dropped or falsely flagged.
   */
  skipped: number;
  /** True when the project has no journal on disk (nothing to verify). */
  noJournal?: boolean;
  /** The first divergence found, if any (replay stops at the first one). */
  divergence?: {
    sequenceId: number;
    action: string;
    reason: string;
  };
}

/**
 * True when a journal payload is the small ref placeholder the EventBus writes
 * for an oversized event, rather than the original payload. Such events hash
 * over the spilled original, so they must be excluded from inline replay.
 */
function isSpilledPayload(payload: string): boolean {
  try {
    const parsed = JSON.parse(payload);
    return (
      parsed != null &&
      typeof parsed === "object" &&
      typeof (parsed as any).refId === "string" &&
      typeof (parsed as any).summary === "string" &&
      (parsed as any).summary.includes("Truncated large payload")
    );
  } catch {
    return false;
  }
}

/**
 * Replays a recorded event list through {@link ReplayEngine} to confirm that each
 * inline event's `action` + `payload` still hashes to its stored `payloadHash`.
 *
 * This is the §2.5 behaviour-replay *primitive*: it detects on-disk corruption or
 * tampering where an event's payload and its hash have diverged (the same
 * "make corruption observable" family as the checkpoint-integrity check). Spilled
 * oversized events are counted as `skipped` (not failures). Pure — no I/O.
 */
export function verifyJournalReplay(events: ReplayEvent[]): JournalReplayResult {
  const ordered = [...events].sort((a, b) => a.sequenceId - b.sequenceId);
  const inline = ordered.filter((e) => !isSpilledPayload(e.payload));
  const skipped = ordered.length - inline.length;

  // ReplayEngine steps through its own (sorted) array one playback() per event,
  // so it must see exactly the events we replay — hence the inline-only list.
  const engine = new ReplayEngine(inline);
  let verified = 0;

  for (const e of inline) {
    try {
      engine.playback(e.action, e.payload);
      verified++;
    } catch (err: any) {
      return {
        ok: false,
        total: events.length,
        verified,
        skipped,
        divergence: {
          sequenceId: e.sequenceId,
          action: e.action,
          reason: err?.message ?? String(err),
        },
      };
    }
  }

  return { ok: true, total: events.length, verified, skipped };
}

/**
 * Loads a project's durable event journal and verifies it via
 * {@link verifyJournalReplay}. Read-only: if no journal exists yet it returns a
 * vacuous-ok result with `noJournal: true` (without creating an empty DB).
 */
export function replaySessionJournal(projectRoot: string): JournalReplayResult {
  const path = EventJournal.resolvePath(projectRoot);
  if (path !== ":memory:" && !existsSync(path)) {
    return { ok: true, total: 0, verified: 0, skipped: 0, noJournal: true };
  }
  const journal = new EventJournal(projectRoot);
  try {
    return verifyJournalReplay(journal.readEvents());
  } finally {
    journal.close();
  }
}
