import { LoopDetector } from "@agency/heuristics";

export type SkillHarnessMode = "default" | "long-reasoning" | "long-runner";

export interface HarnessOptions {
  mode: SkillHarnessMode;
  maxTurns?: number;
  checkpointEvery?: number;
  hintSkills?: string[];
}

const LONG_REASONING_HINT = ["codex-reasoning-rigor"];
const LONG_RUNNER_HINT = ["codex-subagent-execution"];

export function getHarnessConfig(mode: SkillHarnessMode): HarnessOptions {
  switch (mode) {
    case "long-reasoning":
      return {
        mode,
        maxTurns: 40,
        hintSkills: LONG_REASONING_HINT,
      };
    case "long-runner":
      return {
        mode,
        checkpointEvery: 1,
        hintSkills: LONG_RUNNER_HINT,
      };
    default:
      return { mode };
  }
}

export function inferHarnessMode(skillName: string): SkillHarnessMode {
  if (skillName === "codex-subagent-execution") {
    return "long-runner";
  }
  if (skillName === "codex-reasoning-rigor") {
    return "long-reasoning";
  }
  return "default";
}

export function harnessModeHint(skillName: string): string {
  const mode = inferHarnessMode(skillName);
  const config = getHarnessConfig(mode);
  if (mode === "default") {
    return "harness: default";
  }
  const parts = [`harness: ${mode}`];
  if (config.maxTurns !== undefined) {
    parts.push(`maxTurns=${config.maxTurns}`);
  }
  if (config.checkpointEvery !== undefined) {
    parts.push(`checkpointEvery=${config.checkpointEvery}`);
  }
  if (config.hintSkills?.length) {
    parts.push(`hints=${config.hintSkills.join(",")}`);
  }
  return parts.join(" ");
}

export interface VerificationResult {
  passed: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
  error?: string;
}

export interface HarnessRunResult<T> {
  success: boolean;
  attempts: number;
  output: T;
  verificationLogs: VerificationResult[];
}

export async function runWithVerificationHarness<T>(
  execute: (attempt: number, lastError?: string) => Promise<T>,
  verify: () => Promise<VerificationResult>,
  options: { maxAttempts?: number } = {}
): Promise<HarnessRunResult<T>> {
  const maxAttempts = options.maxAttempts ?? 3;
  const verificationLogs: VerificationResult[] = [];
  let lastError: string | undefined;
  let output: T;

  const loopDetector = new LoopDetector();

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    output = await execute(attempt, lastError);
    const check = await verify();
    verificationLogs.push(check);

    if (check.passed) {
      return {
        success: true,
        attempts: attempt,
        output,
        verificationLogs,
      };
    }

    const errorSignature = `Exit Code: ${check.exitCode}\nStdout: ${check.stdout}\nStderr: ${check.stderr}`;
    loopDetector.addError(errorSignature);

    const loopCheck = loopDetector.detectLoop();
    if (loopCheck.loopDetected) {
      throw new Error(`[Loop Detected] ${loopCheck.reason || "Execution halted due to infinite cyclic loop."}`);
    }

    lastError = `[Attempt ${attempt} Verification Failed]\n${errorSignature}`;
  }

  return {
    success: false,
    attempts: maxAttempts,
    output: output!,
    verificationLogs,
  };
}

