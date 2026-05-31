export interface FileLock {
  filePath: string;
  workerId: string;
  acquiredAt: number;
  timeoutMs: number;
}

export interface StagedChange {
  relativePath: string;
  originalContent: string | null; // null if created
  stagedContent: string | null;   // null if deleted
  timestamp: number;
}

export interface WorkspaceTransaction {
  id: string;
  stagedChanges: Map<string, StagedChange>;
  status: "active" | "committed" | "rolled_back";
}
