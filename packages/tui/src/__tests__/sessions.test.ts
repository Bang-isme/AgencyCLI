import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createSession,
  listSessionIds,
  loadSession,
  saveSession,
} from "../sessions/store.js";

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
