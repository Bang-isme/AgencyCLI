import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createSession,
  forkSession,
  listSessionIds,
  loadSession,
  saveSession,
} from "../sessions/store.js";
import type { SessionMessage } from "../state/messages.js";

const dirs: string[] = [];

afterEach(() => {
  for (const d of dirs) {
    rmSync(d, { recursive: true, force: true });
  }
  dirs.length = 0;
});

describe("sessions store", () => {
  it("creates and persists session under .agency/sessions", () => {
    const root = mkdtempSync(join(tmpdir(), "agency-sess-"));
    dirs.push(root);
    const session = createSession(root);
    saveSession(session);
    expect(listSessionIds(root)).toContain(session.id);
    const loaded = loadSession(root, session.id);
    expect(loaded?.messages).toEqual([]);
  });
});

describe("forkSession (P4b)", () => {
  const msg = (id: string): SessionMessage => ({ id, role: "user", content: id, timestamp: 1 });
  // Pin the source id so it can't collide with the fork's fresh `sess-<now>` id
  // when both are created in the same millisecond (createSession uses Date.now()).
  const base = () => {
    const s = createSession("/proj");
    return { ...s, id: "sess-original", messages: [msg("a"), msg("b"), msg("c"), msg("d")] };
  };

  it("branches the messages up to and including the focused turn", () => {
    const forked = forkSession(base(), "b");
    expect(forked.messages.map((m) => m.id)).toEqual(["a", "b"]);
  });

  it("gets a fresh id and does not mutate the source", () => {
    const src = base();
    const forked = forkSession(src, "b");
    expect(forked.id).not.toBe(src.id);
    expect(src.messages).toHaveLength(4); // source untouched
    // messages are cloned, not shared references
    expect(forked.messages[0]).not.toBe(src.messages[0]);
    expect(forked.messages[0]).toEqual(src.messages[0]);
  });

  it("copies the whole history when the id is missing (plain duplicate)", () => {
    const forked = forkSession(base(), "zzz");
    expect(forked.messages.map((m) => m.id)).toEqual(["a", "b", "c", "d"]);
  });
});
