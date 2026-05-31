import { createServer, Server } from "node:http";
import { MemoryStorageBackend } from "./storage-backend.js";

export class DashboardServer {
  private backend: MemoryStorageBackend;
  private server: Server | null = null;

  constructor(backend: MemoryStorageBackend) {
    this.backend = backend;
  }

  public startDashboard(port = 8520): void {
    if (this.server) return;

    this.server = createServer((req, res) => {
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Content-Type", "application/json");

      if (req.url === "/api/graph") {
        const vectors = this.backend.queryVectors();
        const nodes = vectors.map((v) => ({ id: v.id, type: v.symbol_type ?? "symbol", content: v.content }));
        
        const edges: any[] = [];
        for (const node of nodes) {
          const neighbors = this.backend.getNeighbors(node.id);
          for (const edge of neighbors) {
            edges.push({ source: edge.source_id, target: edge.target_id, type: edge.relation_type, weight: edge.weight });
          }
        }

        res.end(JSON.stringify({ nodes, edges }));
      } else if (req.url === "/api/telemetry") {
        res.end(JSON.stringify(this.backend.getTelemetry()));
      } else {
        res.writeHead(404);
        res.end(JSON.stringify({ error: "Endpoint not found" }));
      }
    });

    this.server.listen(port);
  }

  public stopDashboard(): void {
    if (this.server) {
      this.server.close();
      this.server = null;
    }
  }
}
