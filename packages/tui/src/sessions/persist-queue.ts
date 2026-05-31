import type { AgencySession } from "./store.js";
import { saveSession } from "./store.js";

let timer: ReturnType<typeof setTimeout> | null = null;
let pending: AgencySession | null = null;

const DEFAULT_MS = 450;

/** Debounce disk writes during streaming / rapid UI updates. */
export function queueSaveSession(session: AgencySession, delayMs = DEFAULT_MS): void {
  pending = session;
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    const snap = pending;
    pending = null;
    if (snap) saveSession(snap);
  }, delayMs);
}

export function flushSessionSave(): void {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  if (pending) {
    saveSession(pending);
    pending = null;
  }
}
