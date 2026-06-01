import { execa } from "execa";
import { join } from "node:path";
import { BUILTIN_SCRIPTS } from "./builtins.js";
import { loadPluginTools } from "./registry.js";

/** Context handed to {@link RunToolOptions.onBeforeRun} before a tool executes. */
export interface RunToolGateContext {
  toolName: string;
  writesArtifacts: boolean;
  yes: boolean;
  projectRoot?: string;
}

export interface RunToolOptions {
  cwd?: string;
  yes?: boolean;
  projectRoot?: string;
  /**
   * Optional approval-gate hook, invoked once before the script runs. The bridge
   * is pure mechanism (run the Python script); the CALLER injects policy here —
   * warn/audit when a write-capable tool runs without explicit approval. Keeping
   * the policy in the caller (the CLI) is why this package no longer imports
   * `@agency/core` (that back-edge formed a `core ↔ skills-bridge` package import
   * cycle). Absent ⇒ the script just runs.
   */
  onBeforeRun?: (ctx: RunToolGateContext) => void;
}

export interface RunToolResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

// `undefined` = not yet probed, `null` = no Python interpreter found.
let cachedPythonBin: string | null | undefined;

/**
 * Resolve a working Python interpreter, trying `python3`, `python`, then the
 * Windows `py` launcher. The result is cached for the process. Returns `null`
 * if none respond to `--version` (callers then surface a clear error and the
 * router degrades to the built-in heuristic).
 */
export async function resolvePythonBin(): Promise<string | null> {
  if (cachedPythonBin !== undefined) return cachedPythonBin;
  for (const bin of ["python3", "python", "py"]) {
    try {
      const probe = await execa(bin, ["--version"], { reject: false });
      if (probe.exitCode === 0) {
        cachedPythonBin = bin;
        return bin;
      }
    } catch {
      // binary not found on PATH — try the next candidate
    }
  }
  cachedPythonBin = null;
  return null;
}

async function execPythonScript(
  skillsRoot: string,
  scriptRel: string,
  argv: string[],
  opts: RunToolOptions
): Promise<RunToolResult> {
  const python = await resolvePythonBin();
  if (!python) {
    return {
      exitCode: 1,
      stdout: "",
      stderr:
        "Python interpreter not found (tried python3, python, py). " +
        "Install Python 3 to enable the skills pack; routing falls back to the built-in heuristic.",
    };
  }
  const script = join(skillsRoot, scriptRel);
  const result = await execa(python, [script, ...argv], {
    cwd: opts.cwd,
    reject: false,
  });
  return {
    exitCode: result.exitCode ?? 1,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

export async function runTool(
  skillsRoot: string,
  toolName: string,
  argv: string[],
  opts: RunToolOptions = {}
): Promise<RunToolResult> {
  const reg = loadPluginTools(skillsRoot);
  const tool = reg.tools.find((t) => t.name === toolName);
  if (!tool) throw new Error(`Unknown tool: ${toolName}`);
  opts.onBeforeRun?.({
    toolName,
    writesArtifacts: tool.safety_policy.writes_artifacts,
    yes: Boolean(opts.yes),
    projectRoot: opts.projectRoot,
  });
  return execPythonScript(skillsRoot, tool.script, argv, opts);
}

export async function runBuiltinScript(
  skillsRoot: string,
  name: string,
  argv: string[],
  opts: RunToolOptions = {}
): Promise<RunToolResult> {
  const scriptRel = BUILTIN_SCRIPTS[name];
  if (!scriptRel) throw new Error(`Unknown builtin: ${name}`);
  return execPythonScript(skillsRoot, scriptRel, argv, opts);
}
