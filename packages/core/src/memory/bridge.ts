import { execa } from "execa";
import { join } from "node:path";
import { ApprovalRequiredError } from "../approval/policy.js";

export { ApprovalRequiredError };

export const MEMORY_SCRIPTS = {
  status: "codex-project-memory/scripts/memory_status.py",
  build: "codex-project-memory/scripts/build_knowledge_index.py",
  genome: "codex-project-memory/scripts/generate_genome.py",
} as const;

export type MemoryScriptAction = keyof typeof MEMORY_SCRIPTS;

export interface RunMemoryScriptOptions {
  cwd?: string;
  yes?: boolean;
}

export interface RunMemoryScriptResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

async function execPythonScript(
  skillsRoot: string,
  scriptRel: string,
  argv: string[],
  opts: RunMemoryScriptOptions
): Promise<RunMemoryScriptResult> {
  const script = join(skillsRoot, scriptRel);
  try {
    const result = await execa("python", [script, ...argv], {
      cwd: opts.cwd,
      reject: false,
    });
    return {
      exitCode: result.exitCode ?? 1,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  } catch (err: any) {
    if (err?.code === "ENOENT") {
      // 'python' binary not found, try 'python3' fallback
      try {
        const result = await execa("python3", [script, ...argv], {
          cwd: opts.cwd,
          reject: false,
        });
        return {
          exitCode: result.exitCode ?? 1,
          stdout: result.stdout,
          stderr: result.stderr,
        };
      } catch (err3: any) {
        return {
          exitCode: 127,
          stdout: "",
          stderr: `Failed to execute Python script. Tried both 'python' and 'python3' binaries but neither was found in your PATH.\nError: ${err3?.message || err3}`,
        };
      }
    }
    return {
      exitCode: 127,
      stdout: "",
      stderr: `Failed to execute python script.\nError: ${err?.message || err}`,
    };
  }
}

export async function runMemoryScript(
  skillsRoot: string,
  action: MemoryScriptAction,
  argv: string[],
  opts: RunMemoryScriptOptions = {}
): Promise<RunMemoryScriptResult> {
  const scriptRel = MEMORY_SCRIPTS[action];
  if (!scriptRel) throw new Error(`Unknown memory action: ${action}`);
  if (action === "build" && !opts.yes) {
    throw new ApprovalRequiredError(
      "memory build requires approval (--yes or TUI confirm)"
    );
  }
  return execPythonScript(skillsRoot, scriptRel, argv, opts);
}
