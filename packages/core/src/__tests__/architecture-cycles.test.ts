import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Architecture guard — runtime import cycles in `@agency/core`.
 *
 * The chat layer has ONE irreducible *functional* runtime import cycle: a chat
 * turn runs tools (`skill/tool-harness`), a tool can dispatch a sub-agent
 * (`agents/orchestrator` + `task/runner`), and a sub-agent runs a chat turn
 * (`chat/stream`) — plus the shared turn setup (`chat/turn-helpers → chat/prompt
 * → skill/tool-harness`). Those edges reflect real runtime relationships;
 * removing them would need dependency injection / lazy imports.
 *
 * A module joining this cycle from OUTSIDE that set almost always means a
 * **layering violation**: a lower/utility/presentation module reaching up into
 * the chat orchestrator. That is exactly what put `context/pack.ts`,
 * `agents/orchestrator.ts` and `chat/presentation.ts` on the cycle — each
 * imported `chat/orchestrator.ts` only for the pure route→string helpers
 * `formatRouteSummary` / `buildSuggestedCommands`, until those moved to the
 * `chat/route-presentation.ts` leaf. Such a cycle also breaks module-mocking
 * under test (a partial mock whose factory calls `importOriginal()` pulls the
 * real orchestrator back through the cycle).
 *
 * This guard fails if any module OUTSIDE the known functional set lands in a
 * runtime cycle — so the tangle can shrink, but never silently grow. If you add
 * a genuinely new functional cycle member, update `ALLOWED_CYCLE` deliberately
 * (and document why); if the failure is a lower layer reaching up for a helper,
 * move the helper to a leaf instead.
 */
const ALLOWED_CYCLE = new Set([
  "agents/orchestrator",
  "chat/orchestrator",
  "chat/prompt",
  "chat/stream",
  "chat/turn-helpers",
  "skill/tool-harness",
  "task/runner",
]);

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Module id = the source path relative to `src`, `/`-separated, no extension. */
function moduleId(absPath: string): string {
  return relative(SRC, absPath).replace(/\\/g, "/").replace(/\.ts$/, "");
}

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    const s = statSync(p);
    if (s.isDirectory()) {
      if (entry === "__tests__") continue;
      out.push(...listSourceFiles(p));
    } else if (entry.endsWith(".ts") && !entry.endsWith(".d.ts")) {
      out.push(p);
    }
  }
  return out;
}

/**
 * Build the RUNTIME import graph (value edges only — `import type` / `export
 * type` are erased by the compiler and create no runtime cycle). Captures both
 * `import … from "…"` (and side-effect `import "…"`) and `export … from "…"`.
 */
function buildGraph(): Map<string, Set<string>> {
  const files = listSourceFiles(SRC);
  const ids = new Set(files.map(moduleId));
  const graph = new Map<string, Set<string>>();
  const importRe = /import\s+(type\s+)?(?:[^"';]*?from\s+)?["'](\.[^"']+)["']/g;
  const exportRe = /export\s+(type\s+)?[^"';]*?from\s+["'](\.[^"']+)["']/g;

  for (const file of files) {
    const txt = readFileSync(file, "utf8");
    const deps = new Set<string>();
    for (const re of [importRe, exportRe]) {
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(txt))) {
        if (m[1]) continue; // `type`-only specifier — erased at runtime
        const targetAbs = resolve(dirname(file), m[2].replace(/\.js$/, ""));
        const target = moduleId(targetAbs);
        if (ids.has(target) && target !== moduleId(file)) deps.add(target);
      }
    }
    graph.set(moduleId(file), deps);
  }
  return graph;
}

/** Tarjan SCC — returns every module that sits in a cycle (SCC of size > 1). */
function modulesInCycles(graph: Map<string, Set<string>>): Set<string> {
  let idx = 0;
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Map<string, boolean>();
  const stack: string[] = [];
  const inCycle = new Set<string>();

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
      if (comp.length > 1) for (const m of comp) inCycle.add(m);
    }
  };

  for (const v of graph.keys()) if (!index.has(v)) strongConnect(v);
  return inCycle;
}

describe("architecture: runtime import cycles", () => {
  it("contains no layering-violation cycles — only the known functional core", () => {
    const graph = buildGraph();
    const inCycle = modulesInCycles(graph);

    // Sanity: the detector actually works (the functional core IS a cycle), so
    // an empty result can't pass the invariant vacuously.
    expect(inCycle.has("chat/orchestrator")).toBe(true);
    expect(inCycle.has("chat/stream")).toBe(true);

    // Invariant: nothing outside the allowed functional set sits in a cycle.
    const offenders = [...inCycle].filter((m) => !ALLOWED_CYCLE.has(m)).sort();
    expect(offenders, `unexpected module(s) in a runtime import cycle — likely a layering violation (a lower layer importing chat/orchestrator). Offenders: ${offenders.join(", ")}`).toEqual([]);
  });
});
