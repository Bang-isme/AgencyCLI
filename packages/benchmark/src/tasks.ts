import { BenchmarkTask, TaskCategory } from "./types.js";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";

const localRequire = createRequire(import.meta.url);

/**
 * Resolve the real TypeScript compiler from the installed `typescript` dependency.
 * We deliberately do NOT shell out to `npx tsc`: the isolated benchmark workspace
 * is a copy of the repo with `node_modules` excluded (it's gitignored), so inside
 * the temp dir `npx tsc` finds no local install and falls through to the deprecated
 * `tsc` *squatter* package on npm ("This is not the tsc command you are looking
 * for", exit 1) — which made this smoke task fail deterministically in any clean
 * environment. Resolving the bin from our own dep tree and running it with `node`
 * keeps the check hermetic (no network, no reliance on the temp copy).
 */
function resolveTscBin(): string | null {
  try {
    return localRequire.resolve("typescript/bin/tsc");
  } catch {
    return null;
  }
}

export const fileAnalysisTask: BenchmarkTask = {
  id: "file-analysis",
  name: "File Analysis Task",
  objective: "Verify that all files in a source directory are valid TypeScript files and have appropriate exports",
  setup: async (projectRoot) => {
    await fs.mkdir(join(projectRoot, "src"), { recursive: true });
    await fs.writeFile(
      join(projectRoot, "src", "index.ts"),
      `export function hello() {\n  return "world";\n}\n`
    );
  },
  validate: async (projectRoot) => {
    try {
      const content = await fs.readFile(join(projectRoot, "src", "index.ts"), "utf8");
      const hasExport = content.includes("export function hello");
      return { success: hasExport, error: hasExport ? undefined : "Missing hello export" };
    } catch (e: any) {
      return { success: false, error: e.message };
    }
  },
  cleanup: async (projectRoot) => {
    await fs.rm(join(projectRoot, "src"), { recursive: true, force: true });
  }
};

export const astSearchTask: BenchmarkTask = {
  id: "ast-search",
  name: "AST Search Task",
  objective: "Identify and extract all arrow functions from a source file using simple parsing",
  setup: async (projectRoot) => {
    await fs.mkdir(join(projectRoot, "src"), { recursive: true });
    await fs.writeFile(
      join(projectRoot, "src", "helper.ts"),
      `export const add = (a: number, b: number) => a + b;\nexport const sub = (a: number, b: number) => a - b;\n`
    );
  },
  validate: async (projectRoot) => {
    try {
      const content = await fs.readFile(join(projectRoot, "src", "helper.ts"), "utf8");
      // Find matches of arrow functions
      const matches = content.match(/=>/g);
      const count = matches ? matches.length : 0;
      return { success: count === 2, error: count === 2 ? undefined : `Expected 2 arrow functions, found ${count}` };
    } catch (e: any) {
      return { success: false, error: e.message };
    }
  },
  cleanup: async (projectRoot) => {
    await fs.rm(join(projectRoot, "src"), { recursive: true, force: true });
  }
};

export const scriptCompilationTask: BenchmarkTask = {
  id: "script-compilation",
  name: "Script Compilation Task",
  objective: "Compile a simple TypeScript file using tsc and verify output files exist",
  setup: async (projectRoot) => {
    await fs.mkdir(join(projectRoot, "src"), { recursive: true });
    await fs.writeFile(
      join(projectRoot, "src", "main.ts"),
      `const value: number = 42;\nconsole.log(value);\n`
    );
    await fs.writeFile(
      join(projectRoot, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          target: "ES2022",
          module: "NodeNext",
          moduleResolution: "NodeNext",
          outDir: "dist",
          rootDir: "src"
        },
        include: ["src/**/*"]
      }, null, 2)
    );
  },
  validate: async (projectRoot) => {
    const tscBin = resolveTscBin();
    if (!tscBin) {
      return { success: false, error: "TypeScript compiler not resolvable (install the `typescript` dependency)" };
    }
    return new Promise((resolve) => {
      // Run the resolved compiler with the current node binary — see resolveTscBin
      // for why `npx tsc` is unsafe here. No `shell` so the (possibly spaced) path
      // is passed verbatim.
      const child = spawn(process.execPath, [tscBin], {
        cwd: projectRoot,
        stdio: "ignore"
      });

      child.on("close", async (code) => {
        if (code !== 0) {
          resolve({ success: false, error: `tsc compilation failed with code ${code}` });
          return;
        }

        try {
          const jsExists = await fs.stat(join(projectRoot, "dist", "main.js")).then(() => true).catch(() => false);
          resolve({
            success: jsExists,
            error: jsExists ? undefined : "Output file dist/main.js not generated"
          });
        } catch (e: any) {
          resolve({ success: false, error: e.message });
        }
      });

      child.on("error", (err) => {
        resolve({ success: false, error: `Failed to spawn tsc: ${err.message}` });
      });
    });
  },
  cleanup: async (projectRoot) => {
    await fs.rm(join(projectRoot, "src"), { recursive: true, force: true });
    await fs.rm(join(projectRoot, "dist"), { recursive: true, force: true });
    await fs.rm(join(projectRoot, "tsconfig.json"), { force: true });
  }
};

/**
 * Builds an agent-backed eval task from a broken/incomplete starting state plus
 * a CommonJS acceptance test. The agent's `execute` step (attached by the eval
 * command with `--agent`) must edit the source so `node <testFile>` exits 0.
 * `.cjs` so the test runs as CommonJS regardless of the workspace package type.
 *
 * Factored so every corpus task shares one setup/validate/cleanup implementation
 * (no per-task boilerplate duplication).
 */
function makeNodeTask(opts: {
  id: string;
  name: string;
  objective: string;
  category: TaskCategory;
  /** filename → initial (broken/incomplete) content. */
  files: Record<string, string>;
  /** Acceptance test file to run with node (default "test.cjs"). */
  testFile?: string;
}): BenchmarkTask {
  const testFile = opts.testFile ?? "test.cjs";
  return {
    id: opts.id,
    name: opts.name,
    objective: opts.objective,
    category: opts.category,
    setup: async (projectRoot) => {
      for (const [name, content] of Object.entries(opts.files)) {
        await fs.writeFile(join(projectRoot, name), content);
      }
    },
    validate: (projectRoot) =>
      new Promise((resolve) => {
        const child = spawn("node", [testFile], { cwd: projectRoot, shell: true, stdio: "ignore" });
        child.on("close", (code) =>
          resolve(
            code === 0
              ? { success: true }
              : { success: false, error: `acceptance test failed (exit ${code})` }
          )
        );
        child.on("error", (err) => resolve({ success: false, error: `Failed to run test: ${err.message}` }));
      }),
    cleanup: async (projectRoot) => {
      for (const name of Object.keys(opts.files)) {
        await fs.rm(join(projectRoot, name), { force: true });
      }
    },
  };
}

/** Bugfix: add() subtracts instead of adding. */
export const addBugfixTask = makeNodeTask({
  id: "fix-add-bug",
  name: "Fix the add() bug",
  objective:
    "The function add(a, b) in math.cjs is implemented incorrectly (it subtracts). Fix it so add(a, b) returns a + b. Do not change the test.",
  category: "bugfix",
  files: {
    "math.cjs": `module.exports.add = (a, b) => a - b;\n`,
    "test.cjs": `const { add } = require("./math.cjs");\nprocess.exit(add(2, 3) === 5 && add(10, 0) === 10 ? 0 : 1);\n`,
  },
});

/** Feature: implement a missing multiply() export. */
export const multiplyFeatureTask = makeNodeTask({
  id: "impl-multiply",
  name: "Implement multiply()",
  objective:
    "math.cjs exports add() but is missing multiply(). Add a function multiply(a, b) to math.cjs that returns a * b. Keep the existing add() working. Do not change the test.",
  category: "feature",
  files: {
    "math.cjs": `module.exports.add = (a, b) => a + b;\n`,
    "test.cjs":
      `const m = require("./math.cjs");\nprocess.exit(typeof m.multiply === "function" && m.multiply(3, 4) === 12 && m.multiply(0, 5) === 0 ? 0 : 1);\n`,
  },
});

/** Bugfix: clamp() ignores its bounds. */
export const clampBugfixTask = makeNodeTask({
  id: "fix-clamp-bug",
  name: "Fix the clamp() bug",
  objective:
    "The function clamp(v, min, max) in util.cjs returns v unchanged, ignoring the bounds. Fix it so it returns min when v < min, max when v > max, and v otherwise. Do not change the test.",
  category: "bugfix",
  files: {
    "util.cjs": `module.exports.clamp = (v, min, max) => v;\n`,
    "test.cjs":
      `const { clamp } = require("./util.cjs");\nprocess.exit(clamp(5, 0, 3) === 3 && clamp(-1, 0, 3) === 0 && clamp(2, 0, 3) === 2 ? 0 : 1);\n`,
  },
});

/**
 * Harder corpus — graduated difficulty where a single one-shot attempt
 * frequently produces a *near-miss* (an edge case wrong), so the failing
 * acceptance test gives the verify→self-correct loop something concrete to fix.
 * Each acceptance test prints the failing case(s) to stderr (not `stdio:ignore`)
 * so the eval can feed that signal back into the next round. These are the tasks
 * that discriminate legacy (one shot) from hardened (self-correcting).
 */

/** Subtle string normalisation: naive stub only lowercases + replaces spaces. */
export const slugifyHardTask = makeNodeTask({
  id: "hard-slugify",
  name: "Implement a correct slugify()",
  objective:
    "slug.cjs exports slugify(s) but the implementation is naive (it only lowercases and replaces literal spaces). Fix slugify so it: (1) lowercases the input; (2) replaces every run of one-or-more non-alphanumeric characters with a single hyphen '-'; (3) strips any leading or trailing hyphens. Examples: 'Hello, World!' -> 'hello-world', '  Foo   Bar  ' -> 'foo-bar', 'a--b__c' -> 'a-b-c'. Do not change the test (test.cjs).",
  category: "bugfix",
  files: {
    "slug.cjs": `module.exports.slugify = (s) => String(s).toLowerCase().replace(/ /g, "-");\n`,
    "test.cjs": `const { slugify } = require("./slug.cjs");
const cases = [
  ["Hello, World!", "hello-world"],
  ["  Foo   Bar  ", "foo-bar"],
  ["a--b__c", "a-b-c"],
  ["--Trim--Me--", "trim-me"],
  ["Already-Slugified", "already-slugified"],
  ["Node.js & TypeScript", "node-js-typescript"],
];
let failed = 0;
for (const [input, expected] of cases) {
  let got;
  try { got = slugify(input); } catch (e) { got = "THREW:" + e.message; }
  if (got !== expected) {
    failed++;
    console.error("FAIL slugify(" + JSON.stringify(input) + ") -> expected " + JSON.stringify(expected) + ", got " + JSON.stringify(got));
  }
}
if (failed) { console.error(failed + " case(s) failed"); process.exit(1); }
console.log("all slugify cases passed");
process.exit(0);
`,
  },
});

/** Parser with unit ms/m ambiguity, combined units, and null-on-invalid. */
export const parseDurationHardTask = makeNodeTask({
  id: "hard-parse-duration",
  name: "Implement parseDuration()",
  objective:
    "duration.cjs exports parseDuration(s), which must convert a human duration string into milliseconds, but it is a broken stub. Implement it to support the units ms, s, m, h and combinations like '1h30m' or '2h15m30s' (e.g. '500ms' -> 500, '45s' -> 45000, '30m' -> 1800000, '1h' -> 3600000). Return null for any invalid input (e.g. 'abc', '', '10x'). Do not change the test (test.cjs).",
  category: "feature",
  files: {
    "duration.cjs": `module.exports.parseDuration = (s) => Number(s);\n`,
    "test.cjs": `const { parseDuration } = require("./duration.cjs");
const cases = [
  ["500ms", 500],
  ["45s", 45000],
  ["30m", 1800000],
  ["1h", 3600000],
  ["1h30m", 5400000],
  ["2h15m30s", 8130000],
  ["90m", 5400000],
  ["abc", null],
  ["", null],
  ["10x", null],
];
let failed = 0;
for (const [input, expected] of cases) {
  let got;
  try { got = parseDuration(input); } catch (e) { got = "THREW:" + e.message; }
  if (got !== expected) {
    failed++;
    console.error("FAIL parseDuration(" + JSON.stringify(input) + ") -> expected " + JSON.stringify(expected) + ", got " + JSON.stringify(got));
  }
}
if (failed) { console.error(failed + " case(s) failed"); process.exit(1); }
console.log("all parseDuration cases passed");
process.exit(0);
`,
  },
});

/**
 * Multi-file: the greedy algorithm in roman.cjs is already correct, but the
 * symbol table it consumes (numerals.cjs) is missing the subtractive pairs, so
 * toRoman(4) === "IIII". The fix lives in the *other* file — forces the agent to
 * read both modules and reason across them, not just patch the one it's pointed at.
 */
export const romanNumeralHardTask = makeNodeTask({
  id: "hard-roman-numeral",
  name: "Fix Roman numerals (multi-file)",
  objective:
    "This project converts integers to Roman numerals across two files: roman.cjs (the algorithm) and numerals.cjs (the symbol table it uses). toRoman(n) currently produces non-standard output (e.g. toRoman(4) returns 'IIII' instead of 'IV') because the symbol table is incomplete. Fix the code so toRoman returns standard Roman numerals using subtractive notation (4='IV', 9='IX', 40='XL', 90='XC', 400='CD', 900='CM', so 1994='MCMXCIV'). Do not change the test (test.cjs).",
  category: "bugfix",
  files: {
    "numerals.cjs": `module.exports.NUMERALS = [
  [1000, "M"],
  [500, "D"],
  [100, "C"],
  [50, "L"],
  [10, "X"],
  [5, "V"],
  [1, "I"],
];
`,
    "roman.cjs": `const { NUMERALS } = require("./numerals.cjs");
function toRoman(n) {
  let out = "";
  for (const [val, sym] of NUMERALS) {
    while (n >= val) { out += sym; n -= val; }
  }
  return out;
}
module.exports.toRoman = toRoman;
`,
    "test.cjs": `const { toRoman } = require("./roman.cjs");
const cases = [
  [3, "III"],
  [4, "IV"],
  [9, "IX"],
  [40, "XL"],
  [90, "XC"],
  [400, "CD"],
  [900, "CM"],
  [444, "CDXLIV"],
  [1994, "MCMXCIV"],
  [2023, "MMXXIII"],
];
let failed = 0;
for (const [input, expected] of cases) {
  let got;
  try { got = toRoman(input); } catch (e) { got = "THREW:" + e.message; }
  if (got !== expected) {
    failed++;
    console.error("FAIL toRoman(" + input + ") -> expected " + expected + ", got " + got);
  }
}
if (failed) { console.error(failed + " case(s) failed"); process.exit(1); }
console.log("all toRoman cases passed");
process.exit(0);
`,
  },
});

/**
 * Stateful parser with the classic CSV gotchas: quoted commas, the `""`→`"`
 * escape, and a trailing empty field. A naive one-shot frequently nails the
 * easy cases but misses the escape or the trailing field — a near-miss the
 * printed failing case lets the verify→self-correct loop repair. This is the
 * sharpest legacy↔hardened discriminator in the corpus.
 */
export const csvParseHardTask = makeNodeTask({
  id: "hard-csv-parse",
  name: "Implement a correct single-line CSV parser",
  objective:
    `csv.cjs exports parseCsvLine(line) but the stub just splits on commas, which breaks on quoted fields. Implement a correct single-line CSV parser: (1) fields are comma-separated; (2) a field may be wrapped in double quotes, and commas inside quotes are literal (not separators); (3) inside a quoted field, two consecutive double quotes ("") represent one literal double-quote character; (4) strip the surrounding quotes from the returned value; (5) preserve empty fields, including a trailing empty field after a final comma. Examples: 'a,,c' -> ['a','','c']; '"a,b",c' -> ['a,b','c']; the line "she said ""hi""",ok parses to ['she said "hi"','ok']; '"trailing",' -> ['trailing','']. Do not change the test (test.cjs).`,
  category: "feature",
  files: {
    "csv.cjs": `module.exports.parseCsvLine = (line) => String(line).split(",");\n`,
    "test.cjs": `const { parseCsvLine } = require("./csv.cjs");
const cases = [
  ["a,b,c", ["a", "b", "c"]],
  ["a,,c", ["a", "", "c"]],
  ['"a,b",c', ["a,b", "c"]],
  ['a,"b,c",d', ["a", "b,c", "d"]],
  ['"she said ""hi""",ok', ['she said "hi"', "ok"]],
  ['"",x', ["", "x"]],
  ["hello", ["hello"]],
  ['"trailing",', ["trailing", ""]],
];
let failed = 0;
for (const [input, expected] of cases) {
  let got;
  try { got = parseCsvLine(input); } catch (e) { got = "THREW:" + e.message; }
  const gotStr = JSON.stringify(got);
  const expStr = JSON.stringify(expected);
  if (gotStr !== expStr) {
    failed++;
    console.error("FAIL parseCsvLine(" + JSON.stringify(input) + ") -> expected " + expStr + ", got " + gotStr);
  }
}
if (failed) { console.error(failed + " case(s) failed"); process.exit(1); }
console.log("all parseCsvLine cases passed");
process.exit(0);
`,
  },
});

/**
 * Discriminator task: a counter-conventional spec that overrides the strong
 * training prior (that touching intervals merge). A from-scratch first attempt
 * commonly uses `<=` (merges touching) and fails; the failing-test output makes
 * the one-char fix obvious — so the verify-loop (hardened) can self-heal where a
 * single attempt (legacy) cannot. This is the kind of task that breaks the
 * ceiling effect a strong model has on the rest of the hard corpus.
 */
export const mergeIntervalsHardTask = makeNodeTask({
  id: "hard-merge-intervals",
  name: "Merge overlapping intervals — but NOT ones that merely touch",
  objective:
    `intervals.cjs exports mergeIntervals(intervals) but the stub just returns the input unchanged. Implement it: given an array of [start, end] pairs (integers, start ≤ end, any order), return the merged set sorted ascending by start. IMPORTANT NON-STANDARD RULE: two intervals merge ONLY if one starts STRICTLY BEFORE the other ends — intervals that merely TOUCH (share an endpoint) must NOT be merged and must remain separate. So [1,2] and [2,3] stay as [[1,2],[2,3]] (they only touch), while [1,3] and [2,6] merge into [1,6] (they overlap). Examples: mergeIntervals([[1,3],[2,6],[8,10],[15,18]]) -> [[1,6],[8,10],[15,18]]; mergeIntervals([[1,2],[2,3]]) -> [[1,2],[2,3]]; mergeIntervals([[1,4],[4,5]]) -> [[1,4],[4,5]]; mergeIntervals([[1,5],[2,3]]) -> [[1,5]]; mergeIntervals([]) -> []. Return new arrays (do not mutate the input). Do not change the test (test.cjs).`,
  category: "feature",
  files: {
    "intervals.cjs": `module.exports.mergeIntervals = (intervals) => intervals;\n`,
    "test.cjs": `const { mergeIntervals } = require("./intervals.cjs");
const cases = [
  [[[1, 3], [2, 6], [8, 10], [15, 18]], [[1, 6], [8, 10], [15, 18]]],
  [[[1, 2], [2, 3]], [[1, 2], [2, 3]]],            // touch -> NOT merged
  [[[1, 4], [4, 5]], [[1, 4], [4, 5]]],            // touch -> NOT merged
  [[[1, 5], [2, 3]], [[1, 5]]],                    // contained -> merged
  [[[2, 6], [1, 3]], [[1, 6]]],                    // unsorted overlap -> merged
  [[[5, 6], [1, 2]], [[1, 2], [5, 6]]],            // disjoint -> sorted, separate
  [[[1, 10], [2, 3], [4, 5]], [[1, 10]]],          // both contained
  [[], []],
  [[[7, 7]], [[7, 7]]],                            // single zero-width
];
let failed = 0;
for (const [input, expected] of cases) {
  let got;
  try { got = mergeIntervals(input.map((p) => p.slice())); } catch (e) { got = "THREW:" + e.message; }
  const gotStr = JSON.stringify(got);
  const expStr = JSON.stringify(expected);
  if (gotStr !== expStr) {
    failed++;
    console.error("FAIL mergeIntervals(" + JSON.stringify(input) + ") -> expected " + expStr + ", got " + gotStr);
  }
}
if (failed) { console.error(failed + " case(s) failed"); process.exit(1); }
console.log("all mergeIntervals cases passed");
process.exit(0);
`,
  },
});

/** Validation-only smoke tasks (no agent attempt) — prove the pipeline e2e. */
export const defaultTasks: BenchmarkTask[] = [
  fileAnalysisTask,
  astSearchTask,
  scriptCompilationTask
];

/** Agent-backed corpus: broken/incomplete starting states the agent must fix. */
export const agentEvalTasks: BenchmarkTask[] = [
  addBugfixTask,
  multiplyFeatureTask,
  clampBugfixTask,
];

/**
 * Harder agent-backed corpus — the discriminating set for legacy↔hardened.
 * Keep a separate baseline from `agentEvalTasks` (different difficulty → the
 * regression gate compares like-for-like).
 */
export const hardAgentEvalTasks: BenchmarkTask[] = [
  slugifyHardTask,
  parseDurationHardTask,
  romanNumeralHardTask,
  csvParseHardTask,
  mergeIntervalsHardTask,
];
