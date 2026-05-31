import { createHash } from "node:crypto";
import { ReplayEvent } from "@agency/contracts";

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
