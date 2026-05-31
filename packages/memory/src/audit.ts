import { MemoryStorageBackend } from "./storage-backend.js";
import { AuditEntry } from "./types.js";

export class AuditLog {
  private backend: MemoryStorageBackend;

  constructor(backend: MemoryStorageBackend) {
    this.backend = backend;
  }

  public logMutation(
    recordId: string,
    tableName: string,
    actor: string,
    reason: string,
    mutationType: "INSERT" | "UPDATE" | "DELETE" | "ROLLBACK",
    preState: any = null,
    postState: any = null
  ): number {
    const entry: AuditEntry = {
      record_id: recordId,
      table_name: tableName,
      actor,
      reason,
      mutation_type: mutationType,
      pre_state: preState,
      post_state: postState,
      timestamp: Date.now(),
    };
    return this.backend.logMutation(entry);
  }

  /**
   * Reverts all mutations in descending order starting from the specified audit log ID (inclusive)
   */
  public rollbackFromId(auditLogId: number): void {
    const history = this.backend.getAuditHistory(""); // fetch or query audit history
    // For simplicity, we can get all audit entries and filter in memory since typical audit histories are small
    const targetHistory = history.filter((h) => h.id !== undefined && h.id >= auditLogId);

    // Rollback operations in reverse order (newest first)
    this.backend.runTransaction(() => {
      for (const audit of targetHistory) {
        this.rollbackSingleEntry(audit);
      }
    });
  }

  private rollbackSingleEntry(audit: AuditEntry): void {
    // Check table name and pre/post states to dynamically reconstruct the record
    if (audit.table_name === "episodes") {
      const episode = audit.pre_state;
      if (audit.mutation_type === "INSERT") {
        // Delete the inserted episode
        // For simplicity, we delete by Turn Index and Session ID
        this.backend.deleteEpisodes(episode.session_id, episode.tenant_id);
      } else if (audit.mutation_type === "UPDATE" || audit.mutation_type === "DELETE") {
        // Restore pre_state values
        this.backend.addEpisode(episode);
      }
    } else if (audit.table_name === "vectors") {
      const vector = audit.pre_state;
      if (audit.mutation_type === "INSERT") {
        this.backend.deleteVector(audit.record_id);
      } else if (audit.mutation_type === "UPDATE" || audit.mutation_type === "DELETE") {
        this.backend.insertVector(vector);
      }
    }
  }
}
