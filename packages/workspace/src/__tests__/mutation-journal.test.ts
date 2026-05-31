import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
  commitMutationsAtomic,
  recoverPendingMutations,
  writeMutationJournal,
  mutationJournalPath,
  type MutationEntry,
} from "../mutation-journal.js";

let root = "";

afterEach(() => {
  if (root) {
    rmSync(root, { recursive: true, force: true });
    root = "";
  }
});

function read(rel: string): string | null {
  const f = join(root, rel);
  return existsSync(f) ? readFileSync(f, "utf8") : null;
}

describe("commitMutationsAtomic", () => {
  it("applies create/modify/delete and clears the journal on success", () => {
    root = mkdtempSync(join(tmpdir(), "agency-mut-"));
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "b.ts"), "old-b", "utf8");
    writeFileSync(join(root, "src", "c.ts"), "old-c", "utf8");

    const muts: MutationEntry[] = [
      { relativePath: "src/a.ts", originalContent: null, stagedContent: "new-a" }, // create
      { relativePath: "src/b.ts", originalContent: "old-b", stagedContent: "new-b" }, // modify
      { relativePath: "src/c.ts", originalContent: "old-c", stagedContent: null }, // delete
    ];

    const committed = commitMutationsAtomic(root, "tx-1", muts);

    expect(new Set(committed)).toEqual(new Set(["src/a.ts", "src/b.ts", "src/c.ts"]));
    expect(read("src/a.ts")).toBe("new-a");
    expect(read("src/b.ts")).toBe("new-b");
    expect(read("src/c.ts")).toBeNull();
    expect(existsSync(mutationJournalPath(root, "tx-1"))).toBe(false);
  });

  it("is a no-op for an empty mutation set", () => {
    root = mkdtempSync(join(tmpdir(), "agency-mut-"));
    expect(commitMutationsAtomic(root, "tx-empty", [])).toEqual([]);
    expect(existsSync(mutationJournalPath(root, "tx-empty"))).toBe(false);
  });
});

describe("recoverPendingMutations", () => {
  it("rolls back a half-applied (committing) commit and clears the journal", () => {
    root = mkdtempSync(join(tmpdir(), "agency-mut-"));
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "b.ts"), "old-b", "utf8");

    // Simulate a crash mid-commit: journal persisted "committing" + staged side
    // already written to disk (a.ts created, b.ts overwritten).
    const muts: MutationEntry[] = [
      { relativePath: "src/a.ts", originalContent: null, stagedContent: "new-a" },
      { relativePath: "src/b.ts", originalContent: "old-b", stagedContent: "new-b" },
    ];
    writeMutationJournal(root, { txId: "tx-9", status: "committing", startedAt: "t", mutations: muts });
    writeFileSync(join(root, "src", "a.ts"), "new-a", "utf8");
    writeFileSync(join(root, "src", "b.ts"), "new-b", "utf8");

    const recovered = recoverPendingMutations(root);

    expect(recovered).toEqual([{ txId: "tx-9", rolledBack: 2 }]);
    expect(read("src/a.ts")).toBeNull(); // created file removed
    expect(read("src/b.ts")).toBe("old-b"); // restored to original
    expect(existsSync(mutationJournalPath(root, "tx-9"))).toBe(false);
  });

  it("cleans up a non-committing journal without touching files", () => {
    root = mkdtempSync(join(tmpdir(), "agency-mut-"));
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "x.ts"), "keep", "utf8");
    writeMutationJournal(root, {
      txId: "tx-done",
      status: "committed",
      startedAt: "t",
      mutations: [{ relativePath: "src/x.ts", originalContent: "old", stagedContent: "keep" }],
    });

    const recovered = recoverPendingMutations(root);

    expect(recovered).toEqual([]);
    expect(read("src/x.ts")).toBe("keep");
    expect(existsSync(mutationJournalPath(root, "tx-done"))).toBe(false);
  });

  it("returns [] when there is no mutations dir", () => {
    root = mkdtempSync(join(tmpdir(), "agency-mut-"));
    expect(recoverPendingMutations(root)).toEqual([]);
  });
});
