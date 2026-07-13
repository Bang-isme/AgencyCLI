import { execa } from "execa";

export type VerificationGateState = "passed" | "failed" | "skipped" | "not_configured";

export interface VerificationGateResult {
  /** Stable identifier for the gate, e.g. `build`, `lint`, or `test`. */
  id: string;
  command: string[];
  state: VerificationGateState;
  durationMs: number;
  outputTail: string;
}

export interface VerificationResult {
  /** `not_configured` is deliberately distinct from a verified pass. */
  state: "passed" | "failed" | "not_configured";
  gates: VerificationGateResult[];
  durationMs: number;
  summary: string;
  recoveryHint?: string;
}

export type VerificationCommandRunner = (
  command: string[],
  projectRoot: string
) => Promise<{ exitCode: number; stdout?: string; stderr?: string }>;

function gateId(command: string[]): string {
  const scriptIndex = command.findIndex((part) => part === "run");
  return scriptIndex >= 0 && command[scriptIndex + 1] ? command[scriptIndex + 1]! : command.at(-1) ?? "command";
}

function outputTail(output: string, maxLength = 2_000): string {
  return output.length <= maxLength ? output : output.slice(-maxLength);
}

const defaultRunner: VerificationCommandRunner = async (command, projectRoot) => {
  const [bin, ...args] = command;
  if (!bin) return { exitCode: 1, stderr: "Verification command is empty." };
  const result = await execa(bin, args, { cwd: projectRoot, reject: false });
  return { exitCode: result.exitCode ?? 1, stdout: result.stdout, stderr: result.stderr };
};

/**
 * Execute acceptance commands once and return an honest, surface-independent
 * result. Consumers may decide whether an unconfigured project blocks their
 * workflow, but must not present it as a verified pass.
 */
export async function runVerification(
  projectRoot: string,
  commands: string[][],
  runner: VerificationCommandRunner = defaultRunner
): Promise<VerificationResult> {
  const startedAt = Date.now();
  if (commands.length === 0) {
    return {
      state: "not_configured",
      gates: [],
      durationMs: 0,
      summary: "No build, lint, or test command is configured.",
      recoveryHint: "Add project scripts before relying on automatic verification.",
    };
  }

  const gates: VerificationGateResult[] = [];
  for (const command of commands) {
    if (command.length === 0) continue;
    const gateStartedAt = Date.now();
    const result = await runner(command, projectRoot);
    const output = result.stderr || result.stdout || "";
    const state: VerificationGateState = result.exitCode === 0 ? "passed" : "failed";
    gates.push({
      id: gateId(command),
      command,
      state,
      durationMs: Date.now() - gateStartedAt,
      outputTail: outputTail(output),
    });

    if (state === "failed") {
      const rendered = command.join(" ");
      return {
        state: "failed",
        gates,
        durationMs: Date.now() - startedAt,
        summary: outputTail(output || `${rendered} exited ${result.exitCode}`),
        recoveryHint: `Fix ${gateId(command)} and run ${rendered}.`,
      };
    }
  }

  return {
    state: "passed",
    gates,
    durationMs: Date.now() - startedAt,
    summary: `Passed ${gates.length} verification gate${gates.length === 1 ? "" : "s"}.`,
  };
}
