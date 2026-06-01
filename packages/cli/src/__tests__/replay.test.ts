import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { EventJournal } from "@agency/core";

// Structural shape of a journal event — avoids depending on @agency/contracts
// (the cli package does not declare it; EventJournal.appendEvent type-checks it).
type JournalEvent = ReturnType<typeof mkEvent>;

const PKG_ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "../..");
const CLI_ENTRY = join(PKG_ROOT, "dist", "index.js");

const dirs: string[] = [];

afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs.length = 0;
});

function mkEvent(sequenceId: number, action: string, payloadObj: unknown) {
  const payload = JSON.stringify(payloadObj);
  return {
    sequenceId,
    timestamp: 1000 + sequenceId,
    action,
    payloadHash: createHash("sha256").update(action + ":" + payload).digest("hex"),
    payload,
  };
}

function seedJournal(root: string, events: JournalEvent[]): void {
  const j = new EventJournal(root);
  try {
    for (const e of events) j.appendEvent(e);
  } finally {
    j.close();
  }
}

function runReplay(root: string) {
  return spawnSync(process.execPath, [CLI_ENTRY, "replay", "--project-root", root, "--json"], {
    encoding: "utf8",
  });
}

describe("agency replay", () => {
  it("reports noJournal and exits 0 when no journal exists", () => {
    const root = mkdtempSync(join(tmpdir(), "agency-replay-cli-none-"));
    dirs.push(root);
    const result = runReplay(root);
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout) as { ok: boolean; noJournal?: boolean };
    expect(parsed.ok).toBe(true);
    expect(parsed.noJournal).toBe(true);
  });

  it("verifies a clean journal and exits 0", () => {
    const root = mkdtempSync(join(tmpdir(), "agency-replay-cli-ok-"));
    dirs.push(root);
    seedJournal(root, [mkEvent(1, "task:start", { id: 1 }), mkEvent(2, "task:run", { id: 2 })]);
    const result = runReplay(root);
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout) as { ok: boolean; total: number; verified: number };
    expect(parsed.ok).toBe(true);
    expect(parsed.total).toBe(2);
    expect(parsed.verified).toBe(2);
  });

  it("flags a tampered journal and exits 1", () => {
    const root = mkdtempSync(join(tmpdir(), "agency-replay-cli-bad-"));
    dirs.push(root);
    const tampered: JournalEvent = {
      ...mkEvent(2, "task:run", { id: 2 }),
      payload: JSON.stringify({ id: 999 }),
    };
    seedJournal(root, [mkEvent(1, "task:start", { id: 1 }), tampered]);
    const result = runReplay(root);
    expect(result.status).toBe(1);
    const parsed = JSON.parse(result.stdout) as {
      ok: boolean;
      divergence?: { sequenceId: number };
    };
    expect(parsed.ok).toBe(false);
    expect(parsed.divergence?.sequenceId).toBe(2);
  });
});
