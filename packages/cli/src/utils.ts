import { OutputEngine } from "@agency/core";

export const out = OutputEngine.shared();

export function exitOk(): never {
  process.exit(0);
}

export function exitFail(code = 1): never {
  process.exit(code);
}

/** Exit 0 on success, else 1 — normalises a child/script exit code. */
export function exitFromResult(exitCode: number): never {
  process.exit(exitCode === 0 ? 0 : 1);
}

/**
 * Forward a subprocess's captured output to our own stdio. Ensures stdout ends
 * with a newline; `stderr` is optional (some callers only capture stdout).
 */
export function writeProcessOutput(stdout: string, stderr?: string): void {
  if (stdout) process.stdout.write(stdout + (stdout.endsWith("\n") ? "" : "\n"));
  if (stderr) process.stderr.write(stderr);
}

export function handleError(err: unknown, fallbackTitle = "execution failed"): never {
  if (err instanceof Error) {
    out.failure({
      title: fallbackTitle,
      consequence: err.message,
      recovery: "inspect output above",
    });
  } else {
    out.failure({
      title: fallbackTitle,
      consequence: String(err),
      recovery: "inspect output above",
    });
  }
  exitFail();
}
