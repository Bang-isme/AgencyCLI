import { MemoryStorageBackend } from "./storage-backend.js";
import { GraphEdge } from "./types.js";

export class GraphStore {
  private backend: MemoryStorageBackend;

  constructor(backend: MemoryStorageBackend) {
    this.backend = backend;
  }

  public addEdge(sourceId: string, targetId: string, relationType: string, weight = 1.0, metadata: any = {}): void {
    const edge: GraphEdge = {
      source_id: sourceId,
      target_id: targetId,
      relation_type: relationType,
      weight,
      metadata,
    };
    this.backend.addEdge(edge);
  }

  public removeEdge(sourceId: string, targetId: string, relationType: string): void {
    this.backend.removeEdge(sourceId, targetId, relationType);
  }

  public getNeighbors(sourceId: string): GraphEdge[] {
    return this.backend.getNeighbors(sourceId);
  }

  /**
   * BFS Pathfinding: finds the shortest path of edges from source to target
   */
  public findPath(sourceId: string, targetId: string): GraphEdge[] | null {
    if (sourceId === targetId) return [];

    const queue: { node: string; path: GraphEdge[] }[] = [{ node: sourceId, path: [] }];
    const visited = new Set<string>([sourceId]);

    while (queue.length > 0) {
      const current = queue.shift()!;
      
      if (current.node === targetId) {
        return current.path;
      }

      const neighbors = this.backend.getNeighbors(current.node);
      for (const edge of neighbors) {
        if (!visited.has(edge.target_id)) {
          visited.add(edge.target_id);
          queue.push({
            node: edge.target_id,
            path: [...current.path, edge],
          });
        }
      }
    }

    return null;
  }
}
