import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { queueSaveSession, flushSessionSave } from "../sessions/persist-queue.js";
import * as store from "../sessions/store.js";

describe("persist-queue", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(store, "saveSession").mockImplementation(() => {});
  });

  afterEach(() => {
    flushSessionSave();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("debounces saveSession", () => {
    const session = {
      id: "s1",
      projectRoot: "/p",
      createdAt: 1,
      updatedAt: 1,
      messages: [],
    };
    queueSaveSession(session, 200);
    expect(store.saveSession).not.toHaveBeenCalled();
    vi.advanceTimersByTime(200);
    expect(store.saveSession).toHaveBeenCalledWith(session);
  });
});
