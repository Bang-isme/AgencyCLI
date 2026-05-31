import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const MAX_NODES = 40;
const GRAPH_REL_PATHS = [
  join(".agency", "knowledge", "knowledge-graph.json"),
  join(".codex", "knowledge", "knowledge-graph.json"),
];

export interface GraphNode {
  id: string;
  label: string;
  kind: "file" | "module" | "route" | "model";
}

export interface GraphEdge {
  from: string;
  to: string;
  kind: string;
}

export interface WorkspaceGraphView {
  nodes: GraphNode[];
  edges: GraphEdge[];
  stats: Record<string, number>;
}

interface FileDependencyEntry {
  from: string;
  to: string;
  kind?: string;
}

interface EntrypointEntry {
  path?: string;
  id?: string;
  label?: string;
  kind?: GraphNode["kind"];
}

interface KnowledgeGraphFile {
  file_dependencies?: Record<string, string[]> | FileDependencyEntry[];
  entrypoints?: EntrypointEntry[];
  stats?: Record<string, number>;
}

function basename(path: string): string {
  const parts = path.replace(/\\/g, "/").split("/");
  return parts[parts.length - 1] ?? path;
}

function normalizeDependencies(
  raw: KnowledgeGraphFile["file_dependencies"],
): GraphEdge[] {
  if (!raw) return [];

  if (Array.isArray(raw)) {
    return raw.map((dep) => ({
      from: dep.from,
      to: dep.to,
      kind: dep.kind ?? "import",
    }));
  }

  const edges: GraphEdge[] = [];
  for (const [from, targets] of Object.entries(raw)) {
    for (const to of targets) {
      edges.push({ from, to, kind: "import" });
    }
  }
  return edges;
}

function connectionCount(edges: GraphEdge[], id: string): number {
  return edges.filter((edge) => edge.from === id || edge.to === id).length;
}

function buildView(data: KnowledgeGraphFile): WorkspaceGraphView {
  const allEdges = normalizeDependencies(data.file_dependencies);
  const nodeMap = new Map<string, GraphNode>();
  const entryIds = new Set<string>();

  for (const entry of data.entrypoints ?? []) {
    const id = entry.id ?? entry.path;
    if (!id) continue;
    entryIds.add(id);
    nodeMap.set(id, {
      id,
      label: entry.label ?? basename(id),
      kind: entry.kind ?? "file",
    });
  }

  for (const edge of allEdges) {
    for (const id of [edge.from, edge.to]) {
      if (!nodeMap.has(id)) {
        nodeMap.set(id, {
          id,
          label: basename(id),
          kind: "file",
        });
      }
    }
  }

  let nodeIds = [...nodeMap.keys()];
  if (nodeIds.length > MAX_NODES) {
    nodeIds.sort((a, b) => {
      const entryRank = Number(entryIds.has(b)) - Number(entryIds.has(a));
      if (entryRank !== 0) return entryRank;
      return connectionCount(allEdges, b) - connectionCount(allEdges, a);
    });
    nodeIds = nodeIds.slice(0, MAX_NODES);
  }

  const keptIds = new Set(nodeIds);
  const nodes = nodeIds.map((id) => nodeMap.get(id)!);
  const edges = allEdges.filter(
    (edge) => keptIds.has(edge.from) && keptIds.has(edge.to),
  );

  const stats: Record<string, number> = {
    nodes: nodes.length,
    edges: edges.length,
    entrypoints: (data.entrypoints ?? []).length,
    ...data.stats,
  };

  return { nodes, edges, stats };
}

export function loadKnowledgeGraph(projectRoot: string): WorkspaceGraphView | null {
  for (const relPath of GRAPH_REL_PATHS) {
    const graphPath = join(projectRoot, relPath);
    if (existsSync(graphPath)) {
      try {
        const raw = JSON.parse(readFileSync(graphPath, "utf8")) as KnowledgeGraphFile;
        return buildView(raw);
      } catch {
        // continue
      }
    }
  }
  return null;
}
