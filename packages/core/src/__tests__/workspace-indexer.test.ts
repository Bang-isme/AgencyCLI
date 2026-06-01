import { describe, expect, it, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { incrementalUpdateAsync, writeIndex } from "../index/workspace-indexer.js";

/**
 * §8.7 — index freshness. `incrementalUpdateAsync` must keep the on-disk index
 * faithful to the workspace across the three mutations that matter for the
 * context pack's retrieval: a NEW file appears, an existing file CHANGES, and a
 * file is DELETED. (Regression guard: the removed `changedFiles` fast-path only
 * iterated the existing entries, so it could never add a newly-created file —
 * exactly the file the model just wrote and needs to see next turn.)
 */

describe("Workspace Indexer — incremental freshness (§8.7)", () => {
  let root: string;

  afterEach(() => {
    if (root && existsSync(root)) rmSync(root, { recursive: true, force: true });
  });

  const setup = (): void => {
    root = mkdtempSync(join(tmpdir(), "agency-idx-"));
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "a.ts"), "export const a = 1;\n", "utf8");
    writeFileSync(join(root, "src", "b.ts"), "export const b = 2;\n", "utf8");
  };

  it("adds a newly-created file on the next incremental update", async () => {
    setup();
    writeIndex(root, await incrementalUpdateAsync(root)); // baseline: a.ts, b.ts

    writeFileSync(join(root, "src", "c.ts"), "export const c = 3;\n", "utf8"); // NEW

    const updated = await incrementalUpdateAsync(root);
    const paths = updated.files.map((f) => f.path);
    expect(paths).toContain("src/c.ts"); // the new file is indexed
    expect(paths).toContain("src/a.ts");
    expect(paths).toContain("src/b.ts");
  });

  it("drops a deleted file on the next incremental update", async () => {
    setup();
    writeIndex(root, await incrementalUpdateAsync(root));

    rmSync(join(root, "src", "b.ts"));

    const updated = await incrementalUpdateAsync(root);
    const paths = updated.files.map((f) => f.path);
    expect(paths).not.toContain("src/b.ts"); // deleted file drops out
    expect(paths).toContain("src/a.ts");
  });

  it("re-hashes a file whose content changed, keeping the hash of an unchanged one", async () => {
    setup();
    const base = await incrementalUpdateAsync(root);
    writeIndex(root, base);
    const aHash0 = base.files.find((f) => f.path === "src/a.ts")?.contentHash;
    const bHash0 = base.files.find((f) => f.path === "src/b.ts")?.contentHash;
    expect(aHash0).toBeDefined();

    // Change a.ts (different length → different size → re-hash); leave b.ts.
    writeFileSync(join(root, "src", "a.ts"), "export const a = 1; // edited, longer now\n", "utf8");

    const updated = await incrementalUpdateAsync(root);
    const aEntry = updated.files.find((f) => f.path === "src/a.ts");
    const bEntry = updated.files.find((f) => f.path === "src/b.ts");
    expect(aEntry?.contentHash).not.toBe(aHash0); // changed file re-hashed
    expect(bEntry?.contentHash).toBe(bHash0); // unchanged file keeps its hash
  });
});
