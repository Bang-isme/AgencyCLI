import { appendAudit } from "../approval/audit.js";
import {
  ApprovalRequiredError,
  requiresApproval,
  isSelfKillingCommand,
} from "../approval/policy.js";
import {
  SecurityEscalationManager,
  SecurityLevel,
  DockerSandbox,
  NativeSandbox,
  type SandboxEvent
} from "@agency/security";
import { EventBus } from "../events/event-bus.js";

export interface RunShellOptions {
  yes?: boolean;
  /** When true, do not stream stdout/stderr to the host terminal (TUI-safe). */
  capture?: boolean;
  maxSecurityLevel?: number;
  securityWhitelist?: string[];
  sandboxMode?: "docker" | "native";
  dockerImage?: string;
  dockerNetworkDisabled?: boolean;
  dockerMemoryLimit?: string;
  dockerCpuLimit?: string;

  // New sandbox options
  timeout?: number;
  maxStdoutBytes?: number;
  maxStderrBytes?: number;
  processMemoryLimit?: number;
  onSandboxEvent?: (event: SandboxEvent) => void;
  signal?: AbortSignal;
}

export interface RunShellResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
  stdoutTruncated?: boolean;
  stderrTruncated?: boolean;
}

export async function runShellCommand(
  projectRoot: string,
  command: string,
  opts: RunShellOptions = {}
): Promise<RunShellResult> {
  // HARD refusal — a command that kills Agency's own Node.js process (the CLI/TUI
  // running this very turn) or its PID/PPID is self-terminating; approval cannot
  // make it safe, so it is NEVER executed — not even with `yes` (the model's
  // execute_command passes yes:true, so this is the only line of defence). The
  // old code merely printed a "Blocked command" warning and then ran it anyway,
  // which would kill the agent the moment such a command was approved. The
  // message steers the model to the safe path instead of leaving it stuck.
  if (isSelfKillingCommand(command)) {
    // Two messages: a concise, ACTIONABLE one for the model (so it self-corrects
    // to the safe path) and a terse one-liner for the user-facing warning card
    // (the user doesn't need the lecture — the model already got the guidance).
    const modelMsg =
      `Refused (self-termination): this would kill Agency's own Node process and end the session. ` +
      `To (re)start a dev server just run it (e.g. \`npm run dev\`) — Agency auto-detaches it, so no kill is needed; to free a port, kill only that port's PID, never \`node\` by name.`;
    const userMsg = `⚠ Skipped a command that would kill Agency's own Node process (dev servers auto-restart — no kill needed).`;
    process.stderr.write(`${modelMsg}\n`);
    void EventBus.getInstance().publish("system:warning", { message: userMsg });
    appendAudit(projectRoot, { action: "shell", command, approved: false });
    throw new ApprovalRequiredError(modelMsg);
  }

  // Security clearance check
  const securityManager = new SecurityEscalationManager();
  const maxSecurityLevel = opts.maxSecurityLevel ?? SecurityLevel.Level5_Privileged;
  const whitelist = new Set(opts.securityWhitelist || []);

  const sandboxMode = opts.sandboxMode ?? "native";

  // Native runs require Level5_Privileged
  if (sandboxMode !== "docker") {
    const accessResult = securityManager.checkAccess("run_command", maxSecurityLevel, whitelist);
    if (!accessResult.allowed) {
      const warnMsg = accessResult.reason || `Security Warning: 'run_command' requires a higher security clearance.`;
      process.stderr.write(`${warnMsg}\n`);
      void EventBus.getInstance().publish("system:warning", { message: warnMsg });
    }
  }

  // Approval gate: destructive / self-killing commands must be explicitly
  // approved (CLI `--yes`, or TUI confirmation that forwards `yes: true`).
  // Without approval we record the denied attempt and refuse to execute,
  // rather than warning and running anyway.
  const needsApproval = requiresApproval(command);
  if (needsApproval && !opts.yes) {
    const denyMsg = `Command requires approval (--yes or TUI confirm): ${command}`;
    void EventBus.getInstance().publish("system:warning", { message: denyMsg });
    appendAudit(projectRoot, {
      action: "shell",
      command,
      approved: false,
    });
    throw new ApprovalRequiredError(denyMsg);
  }

  appendAudit(projectRoot, {
    action: "shell",
    command,
    approved: true,
  });

  const onSecurityAlert = (evt: { action: string; payload: any }) => {
    void EventBus.getInstance().publish(evt.action, evt.payload);
  };

  if (sandboxMode === "docker") {
    // Derive security parameters based on maxSecurityLevel
    const networkDisabled = opts.dockerNetworkDisabled ?? (maxSecurityLevel < SecurityLevel.Level4_Network);
    const readOnly = maxSecurityLevel < SecurityLevel.Level3_WorkspaceWrite;

    const sandbox = new DockerSandbox({
      projectRoot,
      image: opts.dockerImage,
      networkDisabled,
      readOnly,
      memoryLimit: opts.dockerMemoryLimit,
      cpuLimit: opts.dockerCpuLimit,
      capture: opts.capture ?? false,
      // Honour the same robustness limits native already used — a hung or
      // log-flooding container must time out / be capped, not run forever.
      timeout: opts.timeout,
      maxStdoutBytes: opts.maxStdoutBytes,
      maxStderrBytes: opts.maxStderrBytes,
      onEvent: opts.onSandboxEvent,
      onSecurityAlert,
      securityLevel: maxSecurityLevel,
      strictMode: maxSecurityLevel === SecurityLevel.Level5_Privileged,
      signal: opts.signal,
    });

    return sandbox.execute(command);
  }

  // Use NativeSandbox for native mode
  const sandbox = new NativeSandbox({
    projectRoot,
    capture: opts.capture ?? false,
    timeout: opts.timeout,
    maxStdoutBytes: opts.maxStdoutBytes,
    maxStderrBytes: opts.maxStderrBytes,
    processMemoryLimit: opts.processMemoryLimit,
    onEvent: opts.onSandboxEvent,
    onSecurityAlert,
    securityLevel: maxSecurityLevel,
    strictMode: maxSecurityLevel === SecurityLevel.Level5_Privileged,
    signal: opts.signal,
  });
  return sandbox.execute(command);
}


