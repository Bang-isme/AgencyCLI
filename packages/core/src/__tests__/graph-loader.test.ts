import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadKnowledgeGraph } from "../graph/loader.js";

const REPO_ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "../../../..");
const FIXTURE = join(REPO_ROOT, "tests", "fixtures", "knowledge-graph.json");

function installGraph(projectRoot: string, data: unknown): void {
  const dir = join(projectRoot, ".agency", "knowledge");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "knowledge-graph.json"), JSON.stringify(data));
}

describe("graph loader", () => {
  it("loads knowledge-graph fixture into nodes and edges", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "agency-graph-"));
    installGraph(tempRoot, JSON.parse(readFileSync(FIXTURE, "utf8")));

    try {
      const view = loadKnowledgeGraph(tempRoot);
      expect(view).not.toBeNull();
      expect(view!.nodes.map((node) => node.id)).toEqual(
        expect.arrayContaining([
          "src/index.ts",
          "src/routes/api.ts",
          "src/models/user.ts",
        ]),
      );
      expect(view!.edges).toHaveLength(3);
      expect(view!.stats.files).toBe(3);
      expect(view!.stats.entrypoints).toBe(2);

      const route = view!.nodes.find((node) => node.id === "src/index.ts");
      expect(route?.kind).toBe("route");
      expect(route?.label).toBe("API entry");

      const model = view!.nodes.find((node) => node.id === "src/models/user.ts");
      expect(model?.kind).toBe("model");
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("returns null when knowledge graph is missing", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "agency-graph-missing-"));
    try {
      expect(loadKnowledgeGraph(tempRoot)).toBeNull();
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("caps nodes at 40 for TUI display", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "agency-graph-cap-"));
    const fileDependencies: Record<string, string[]> = {};
    for (let i = 0; i < 50; i += 1) {
      fileDependencies[`src/file-${i}.ts`] = [`src/file-${i + 1}.ts`];
    }

    installGraph(tempRoot, {
      file_dependencies: fileDependencies,
      entrypoints: [{ path: "src/file-0.ts", kind: "route", label: "Root" }],
    });

    try {
      const view = loadKnowledgeGraph(tempRoot);
      expect(view).not.toBeNull();
      expect(view!.nodes.length).toBeLessThanOrEqual(40);
      expect(view!.nodes.some((node) => node.id === "src/file-0.ts")).toBe(true);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("returns null for invalid JSON", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "agency-graph-invalid-"));
    const dir = join(tempRoot, ".agency", "knowledge");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "knowledge-graph.json"), "{not json");

    try {
      expect(loadKnowledgeGraph(tempRoot)).toBeNull();
      expect(existsSync(join(dir, "knowledge-graph.json"))).toBe(true);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
