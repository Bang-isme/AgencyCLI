import { copyFileSync, existsSync } from "node:fs";
import { MemoryStorageBackend } from "./storage-backend.js";
import { Episode, VectorEntry } from "./types.js";


export class PolicyEngine {
  private retentionRules = new Map<string, { ttlMs: number; archiveOnExpire: boolean }>();

  public registerRetentionPolicy(memoryType: string, ttlMs: number, archiveOnExpire = false): void {
    this.retentionRules.set(memoryType, { ttlMs, archiveOnExpire });
  }

  public evaluateRetention(backend: MemoryStorageBackend): void {
    const now = Date.now();
    // In practice we can run SQLite deletes for expired TTLs.
    // For simplicity, we query vectors and episodes and evaluate them:
    for (const [memoryType, policy] of this.retentionRules.entries()) {
      // Evaluate vectors
      const allVectors = backend.queryVectors();
      for (const vec of allVectors) {
        if (vec.memory_type === memoryType && vec.metadata?.created_at) {
          const age = now - vec.metadata.created_at;
          if (age > policy.ttlMs) {
            if (policy.archiveOnExpire) {
              backend.insertVector({
                ...vec,
                state: "ARCHIVED",
              });
            } else {
              backend.deleteVector(vec.id, vec.tenant_id);
            }
          }
        }
      }
    }
  }
}

export class GraphIntegritySupervisor {
  private backend: MemoryStorageBackend;

  constructor(backend: MemoryStorageBackend) {
    this.backend = backend;
  }

  /**
   * Cleans orphan edges and checks for stale structural cycles
   */
  public verifyIntegrity(): void {
    this.pruneOrphanEdges();
    this.checkStaleRelations();
    this.breakCycles();
  }


  private pruneOrphanEdges(): void {
    // Collect all unique symbol IDs in vectors
    const allVectors = this.backend.queryVectors();
    const activeNodes = new Set(allVectors.map((v) => v.id));

    // Find edges pointing to nodes that no longer exist
    for (const node of activeNodes) {
      const neighbors = this.backend.getNeighbors(node);
      for (const edge of neighbors) {
        if (!activeNodes.has(edge.target_id)) {
          this.backend.removeEdge(edge.source_id, edge.target_id, edge.relation_type);
        }
      }
    }
  }

  private checkStaleRelations(): void {
    // Prune edges with weight close to 0
    const allVectors = this.backend.queryVectors();
    for (const node of allVectors) {
      const neighbors = this.backend.getNeighbors(node.id);
      for (const edge of neighbors) {
        if (edge.weight < 0.05) {
          this.backend.removeEdge(edge.source_id, edge.target_id, edge.relation_type);
        }
      }
    }
  }

  /**
   * DFS Cycle detection returning node loops in dependency graph
   */
  public detectCycles(): string[][] {
    const allVectors = this.backend.queryVectors();
    const activeNodes = allVectors.map((v) => v.id);
    const visited = new Set<string>();
    const recStack = new Set<string>();
    const cycles: string[][] = [];

    const dfs = (node: string, path: string[]) => {
      visited.add(node);
      recStack.add(node);
      path.push(node);

      const neighbors = this.backend.getNeighbors(node);
      for (const edge of neighbors) {
        const next = edge.target_id;
        if (!visited.has(next)) {
          dfs(next, [...path]);
        } else if (recStack.has(next)) {
          // Cycle found
          const startIndex = path.indexOf(next);
          if (startIndex !== -1) {
            cycles.push(path.slice(startIndex));
          }
        }
      }

      recStack.delete(node);
    };

    for (const node of activeNodes) {
      if (!visited.has(node)) {
        dfs(node, []);
      }
    }

    return cycles;
  }

  public breakCycles(): void {
    const cycles = this.detectCycles();
    for (const cycle of cycles) {
      if (cycle.length < 2) continue;
      let lowestEdge: { source_id: string; target_id: string; relation_type: string; weight: number } | null = null;

      for (let i = 0; i < cycle.length; i++) {
        const source = cycle[i]!;
        const target = cycle[(i + 1) % cycle.length]!;
        const neighbors = this.backend.getNeighbors(source);
        const matchingEdges = neighbors.filter(e => e.target_id === target);

        for (const edge of matchingEdges) {
          if (lowestEdge === null || edge.weight < lowestEdge.weight) {
            lowestEdge = {
              source_id: edge.source_id,
              target_id: edge.target_id,
              relation_type: edge.relation_type,
              weight: edge.weight
            };
          }
        }
      }

      if (lowestEdge) {
        this.backend.removeEdge(lowestEdge.source_id, lowestEdge.target_id, lowestEdge.relation_type);
        // Diagnostic → stderr so it never corrupts a CLI `--json` stdout.
        console.error(`[GraphIntegritySupervisor] Cycle detected: ${cycle.join(" -> ")} -> ${cycle[0]}. Broke lowest weight edge: ${lowestEdge.source_id} -[${lowestEdge.relation_type}]-> ${lowestEdge.target_id} (weight: ${lowestEdge.weight})`);
      }
    }
  }
}


export class RecoverySupervisor {
  private backend: MemoryStorageBackend;
  private dbPath: string;
  private shadowBackupPath: string;

  constructor(backend: MemoryStorageBackend, dbPath: string, shadowBackupPath: string) {
    this.backend = backend;
    this.dbPath = dbPath;
    this.shadowBackupPath = shadowBackupPath;
  }

  public triggerShadowBackup(): void {
    if (this.dbPath !== ":memory:" && existsSync(this.dbPath)) {
      try {
        // Run wal_checkpoint to flush WAL changes to main database file before backup
        if ((this.backend as any).db) {
          (this.backend as any).db.pragma("wal_checkpoint(TRUNCATE)");
        }
        copyFileSync(this.dbPath, this.shadowBackupPath);
      } catch {
        // Fail silently during background IO
      }
    }
  }

  public verifyAndRestore(): boolean {
    try {
      const ok = this.backend.integrityCheck();
      if (!ok) {
        this.attemptRestore();
        return false;
      }
      return true;
    } catch {
      this.attemptRestore();
      return false;
    }
  }

  private attemptRestore(): void {
    if (this.dbPath !== ":memory:" && existsSync(this.shadowBackupPath)) {
      try {
        // Force close active connections before copying
        this.backend.close();
        copyFileSync(this.shadowBackupPath, this.dbPath);
      } catch {
        // Critical recovery failure
      }
    }
  }
}

export const STATE_SEVERITY: Record<string, number> = {
  "QUARANTINED": 9,
  "DEGRADED": 8,
  "INVALIDATED": 7,
  "REBUILDING": 6,
  "COLD": 5,
  "WARM": 4,
  "HOT": 3,
  "ACTIVE": 2,
  "ARCHIVED": 1,
};

export class CrdtMerger {
  public static mergeVectors(local: MemoryStorageBackend, remoteVectors: VectorEntry[]): void {
    local.runTransaction(() => {
      const localVectors = local.queryVectors();
      const localMap = new Map(localVectors.map((v) => [v.id, v]));

      for (const remote of remoteVectors) {
        const localEntry = localMap.get(remote.id);
        if (!localEntry) {
          local.insertVector(remote);
        } else {
          if (remote.lamport_timestamp > localEntry.lamport_timestamp) {
            local.insertVector(remote);
          } else if (remote.lamport_timestamp === localEntry.lamport_timestamp) {
            const localSev = STATE_SEVERITY[localEntry.state] ?? 0;
            const remoteSev = STATE_SEVERITY[remote.state] ?? 0;
            if (remoteSev > localSev) {
              local.insertVector(remote);
            } else if (remoteSev === localSev) {
              if (remote.id.localeCompare(localEntry.id) > 0) {
                local.insertVector(remote);
              }
            }
          }
        }
      }
    });
  }

  public static mergeEpisodes(local: MemoryStorageBackend, remoteEpisodes: Episode[]): void {
    local.runTransaction(() => {
      const sessions = new Set(remoteEpisodes.map((e) => e.session_id));
      const localMap = new Map<string, Episode>();

      for (const sess of sessions) {
        const locals = local.queryEpisodes(sess);
        for (const loc of locals) {
          localMap.set(`${sess}_${loc.turn_index}`, loc);
        }
      }

      const db = (local as any).db;

      for (const remote of remoteEpisodes) {
        const key = `${remote.session_id}_${remote.turn_index}`;
        const localEntry = localMap.get(key);

        if (!localEntry) {
          local.addEpisode(remote);
        } else {
          let remoteWins = false;
          if (remote.lamport_timestamp > localEntry.lamport_timestamp) {
            remoteWins = true;
          } else if (remote.lamport_timestamp === localEntry.lamport_timestamp) {
            const localSev = STATE_SEVERITY[localEntry.state] ?? 0;
            const remoteSev = STATE_SEVERITY[remote.state] ?? 0;
            if (remoteSev > localSev) {
              remoteWins = true;
            } else if (remoteSev === localSev) {
              const localIdStr = String(localEntry.id ?? "");
              const remoteIdStr = String(remote.id ?? "");
              if (remoteIdStr.localeCompare(localIdStr) > 0) {
                remoteWins = true;
              }
            }
          }

          if (remoteWins) {
            if (db && localEntry.id !== undefined) {
              db.prepare("DELETE FROM episodes WHERE id = ?").run(localEntry.id);
              db.prepare("DELETE FROM episodes_fts WHERE rowid = ?").run(localEntry.id);
            }
            local.addEpisode(remote);
          }
        }
      }
    });
  }
}

