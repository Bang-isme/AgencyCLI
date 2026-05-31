export { FileLock, StagedChange, WorkspaceTransaction } from "./types.js";
export { LockManager } from "./lock-manager.js";
export { StagingEngine } from "./staging-engine.js";
export { RecoveryEngine } from "./recovery-engine.js";
export {
  commitMutationsAtomic,
  rollbackMutations,
  recoverPendingMutations,
  writeMutationJournal,
  clearMutationJournal,
  mutationJournalPath,
  type MutationEntry,
  type MutationJournal,
  type MutationJournalStatus,
  type MutationRecovery,
} from "./mutation-journal.js";
