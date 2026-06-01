import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Architecture guard — runtime import cycles BETWEEN workspace packages.
 *
 * A package-level dependency cycle (e.g. the `@agency/core ↔ @agency/skills-bridge`
 * cycle that existed until the bridge's `runTool` approval policy was lifted into
 * the CLI) is a build-graph smell: it prevents clean TS project references, can
 * surprise the bundler's init order, and — as that case showed — forces tests to
 * be placed in the wrong package. This guard builds the package graph from the
 * real `from "@agency/<pkg>"` runtime (value) imports across every package's
 * `src` and asserts there are NO cycles. If it fails, invert the offending
 * back-edge (move the shared concern down to a leaf, or inject it from the
 * caller) rather than letting the cycle stand.
 */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const PACKAGES = join(REPO_ROOT, "packages");

function packageDirs(): string[] {
  return readdirSync(PACKAGES).filter((d) => {
    try {
      return (
        statSync(join(PACKAGES, d)).isDirectory() &&
        existsSync(join(PACKAGES, d, "package.json"))
      );
    } catch {
      return false;
    }
  });
}

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    const s = statSync(p);
    if (s.isDirectory()) {
      if (entry === "node_modules" || entry === "dist" || entry === "__tests__") continue;
      out.push(...listSourceFiles(p));
    } else if ((entry.endsWith(".ts") || entry.endsWith(".tsx")) && !entry.endsWith(".d.ts")) {
      out.push(p);
    }
  }
  return out;
}

/** package-dir → set of package-dirs it imports at runtime (value edges only). */
function buildPackageGraph(): { graph: Map<string, Set<string>>; nameOf: Record<string, string> } {
  const dirs = packageDirs();
  const nameOf: Record<string, string> = {};
  const dirByName: Record<string, string> = {};
  for (const d of dirs) {
    const name = JSON.parse(readFileSync(join(PACKAGES, d, "package.json"), "utf8")).name as string;
    nameOf[d] = name;
    dirByName[name] = d;
  }

  const graph = new Map<string, Set<string>>();
  for (const d of dirs) graph.set(d, new Set());

  // `@agency/<pkg>` optionally followed by a `/subpath` export (e.g. core/approval).
  const fromRe = /(?:import|export)\s+(type\s+)?[^"';]*?from\s+["']@agency\/([a-z-]+)(?:\/[^"']*)?["']/g;
  const sideRe = /import\s+["']@agency\/([a-z-]+)(?:\/[^"']*)?["']/g;

  for (const d of dirs) {
    for (const file of listSourceFiles(join(PACKAGES, d, "src"))) {
      const txt = readFileSync(file, "utf8");
      let m: RegExpExecArray | null;
      fromRe.lastIndex = 0;
      while ((m = fromRe.exec(txt))) {
        if (m[1]) continue; // `import type` — erased at runtime
        const target = dirByName["@agency/" + m[2]];
        if (target && target !== d) graph.get(d)!.add(target);
      }
      sideRe.lastIndex = 0;
      while ((m = sideRe.exec(txt))) {
        const target = dirByName["@agency/" + m[1]];
        if (target && target !== d) graph.get(d)!.add(target);
      }
    }
  }
  return { graph, nameOf };
}

function findCycles(graph: Map<string, Set<string>>): string[][] {
  let idx = 0;
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Map<string, boolean>();
  const stack: string[] = [];
  const sccs: string[][] = [];

  const strongConnect = (v: string): void => {
    index.set(v, idx);
    low.set(v, idx);
    idx++;
    stack.push(v);
    onStack.set(v, true);
    for (const w of graph.get(v) ?? []) {
      if (!graph.has(w)) continue;
      if (!index.has(w)) {
        strongConnect(w);
        low.set(v, Math.min(low.get(v)!, low.get(w)!));
      } else if (onStack.get(w)) {
        low.set(v, Math.min(low.get(v)!, index.get(w)!));
      }
    }
    if (low.get(v) === index.get(v)) {
      const comp: string[] = [];
      let w: string;
      do {
        w = stack.pop()!;
        onStack.set(w, false);
        comp.push(w);
      } while (w !== v);
      if (comp.length > 1) sccs.push(comp);
    }
  };

  for (const v of graph.keys()) if (!index.has(v)) strongConnect(v);
  return sccs;
}

describe("architecture: package-level import cycles", () => {
  it("has no runtime dependency cycle between @agency/* packages", () => {
    const { graph, nameOf } = buildPackageGraph();

    // Sanity: the graph was actually built (cli depends on core), so an empty
    // result can't pass the invariant vacuously.
    const cliDir = [...graph.keys()].find((d) => nameOf[d] === "@agency/cli");
    expect(cliDir, "could not locate @agency/cli in the package graph").toBeTruthy();
    expect([...graph.get(cliDir!)!].map((d) => nameOf[d])).toContain("@agency/core");

    const cycles = findCycles(graph).map((c) => c.map((d) => nameOf[d]).sort());
    expect(cycles, `runtime package import cycle(s) detected: ${JSON.stringify(cycles)} — invert the back-edge (push the shared concern to a leaf or inject it from the caller)`).toEqual([]);
  });
});
