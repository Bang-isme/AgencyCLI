import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  rmSync,
  renameSync,
  readdirSync,
} from "node:fs";
import { join, dirname } from "node:path";

/**
 * Crash-surviving mutation journal for atomic multi-file commits.
 *
 * The {@link StagingEngine}'s in-memory transaction is lost the instant the
 * process dies, so a crash *during* `commitTransaction` (after writing file A,
 * before file B) leaves a half-applied, un-rollbackable state. This journal
 * persists the full before/after of every file to disk BEFORE any write, so a
 * partial commit can always be undone — either inline (on a write error) or by
 * {@link recoverPendingMutations} on the next startup.
 *
 * Stored under `.agency/mutations/` (NOT `.agency/tasks/`, which the checkpoint
 * scanner reads) so it can never be mis-parsed as a checkpoint.
 */

export interface MutationEntry {
  relativePath: string;
  /** Content the file had BEFORE the commit (null = file did not exist). Used to roll back. */
  originalContent: string | null;
  /** Content the commit writes (null = the commit deletes the file). */
  stagedContent: string | null;
}

export type MutationJournalStatus = "committing" | "committed" | "rolled_back";

export interface MutationJournal {
  txId: string;
  status: MutationJournalStatus;
  startedAt: string;
  mutations: MutationEntry[];
}

export interface MutationRecovery {
  txId: string;
  rolledBack: number;
}

function journalsDir(projectRoot: string): string {
  return join(projectRoot, ".agency", "mutations");
}

export function mutationJournalPath(projectRoot: string, txId: string): string {
  return join(journalsDir(projectRoot), `${txId}.json`);
}

/** Atomic write (temp + rename) so a crash can't leave a half-written journal. */
export function writeMutationJournal(projectRoot: string, journal: MutationJournal): void {
  const dir = journalsDir(projectRoot);
  mkdirSync(dir, { recursive: true });
  const target = mutationJournalPath(projectRoot, journal.txId);
  const tmp = `${target}.tmp`;
  writeFileSync(tmp, JSON.stringify(journal, null, 2), "utf8");
  renameSync(tmp, target);
}

export function clearMutationJournal(projectRoot: string, txId: string): void {
  try {
    rmSync(mutationJournalPath(projectRoot, txId), { force: true });
  } catch {
    /* best-effort */
  }
}

/** Applies one mutation's staged side to disk (write or delete). */
function applyEntry(projectRoot: string, m: MutationEntry): void {
  const dest = join(projectRoot, m.relativePath);
  if (m.stagedContent === null) {
    if (existsSync(dest)) rmSync(dest, { force: true, recursive: true });
  } else {
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, m.stagedContent, "utf8");
  }
}

/** Restores one mutation's original side (undo a commit). */
function rollbackEntry(projectRoot: string, m: MutationEntry): void {
  const dest = join(projectRoot, m.relativePath);
  if (m.originalContent === null) {
    // File didn't exist before → remove whatever the commit created.
    if (existsSync(dest)) rmSync(dest, { force: true, recursive: true });
  } else {
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, m.originalContent, "utf8");
  }
}

/** Roll back every entry (reverse order) to its original content. */
export function rollbackMutations(projectRoot: string, mutations: MutationEntry[]): void {
  for (let i = mutations.length - 1; i >= 0; i--) {
    rollbackEntry(projectRoot, mutations[i]!);
  }
}

/**
 * Journaled atomic commit. Persists the mutation log (status `committing`)
 * BEFORE touching disk, applies each change, and on ANY failure rolls back the
 * changes already applied so the tree is left in its pre-commit state. On
 * success the journal is cleared. If the process dies mid-apply, the
 * `committing` journal survives and {@link recoverPendingMutations} undoes the
 * partial commit on the next startup. Returns the committed relative paths.
 */
export function commitMutationsAtomic(
  projectRoot: string,
  txId: string,
  mutations: MutationEntry[]
): string[] {
  if (mutations.length === 0) return [];

  writeMutationJournal(projectRoot, {
    txId,
    status: "committing",
    startedAt: new Date().toISOString(),
    mutations,
  });

  const applied: MutationEntry[] = [];
  try {
    for (const m of mutations) {
      applyEntry(projectRoot, m);
      applied.push(m);
    }
  } catch (err) {
    // Undo what we managed to apply so the tree is consistent, then surface.
    rollbackMutations(projectRoot, applied);
    clearMutationJournal(projectRoot, txId);
    throw err instanceof Error ? err : new Error(String(err));
  }

  clearMutationJournal(projectRoot, txId);
  return mutations.map((m) => m.relativePath);
}

/**
 * Startup recovery: find mutation journals left in `committing` state (a crash
 * happened mid-commit), roll their changes back to the original content, and
 * clear them. Returns one entry per recovered transaction. Best-effort — a
 * single corrupt journal never aborts the sweep, and a non-`committing` journal
 * is just cleaned up.
 */
export function recoverPendingMutations(projectRoot: string): MutationRecovery[] {
  const dir = journalsDir(projectRoot);
  if (!existsSync(dir)) return [];
  const recovered: MutationRecovery[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".json") || name.endsWith(".tmp")) continue;
    const path = join(dir, name);
    try {
      const journal = JSON.parse(readFileSync(path, "utf8")) as MutationJournal;
      if (journal.status !== "committing") {
        rmSync(path, { force: true });
        continue;
      }
      rollbackMutations(projectRoot, journal.mutations ?? []);
      rmSync(path, { force: true });
      recovered.push({ txId: journal.txId, rolledBack: journal.mutations?.length ?? 0 });
    } catch {
      // Corrupt/unreadable journal — leave it for manual inspection.
    }
  }
  return recovered;
}
