import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { ProcessJail } from "./process-jail.js";
import { EgressFilterProxy } from "./egress-proxy.js";

export type SandboxEventType = 
  | "timeout"
  | "output-truncated"  
  | "process-killed"
  | "memory-exceeded"
  | "started"
  | "completed";

export interface SandboxEvent {
  type: SandboxEventType;
  timestamp: number;
  detail?: string;
}

export interface SandboxOptions {
  projectRoot: string;
  image?: string;
  networkDisabled?: boolean;
  readOnly?: boolean;
  memoryLimit?: string;
  cpuLimit?: string;
  env?: Record<string, string>;
  capture?: boolean;
  timeout?: number;
  maxStdoutBytes?: number;
  maxStderrBytes?: number;
  processMemoryLimit?: number;
  onEvent?: (event: SandboxEvent) => void;
  onSecurityAlert?: (event: { action: string; payload: any }) => void;
  strictMode?: boolean;
  securityLevel?: number;
  signal?: AbortSignal;
}

export interface SandboxResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
  stdoutTruncated?: boolean;
  stderrTruncated?: boolean;
}

export interface Sandbox {
  execute(command: string): Promise<SandboxResult>;
}

export function isDevServerPattern(command: string, stdout: string, stderr: string): boolean {
  const cmdLower = command.toLowerCase();
  const outputLower = (stdout + "\n" + stderr).toLowerCase();

  const hasDevCommand =
    cmdLower.includes("dev") ||
    cmdLower.includes("start") ||
    cmdLower.includes("serve") ||
    cmdLower.includes("vite") ||
    cmdLower.includes("next") ||
    cmdLower.includes("nodemon") ||
    cmdLower.includes("watch") ||
    cmdLower.includes("webpack") ||
    cmdLower.includes("http-server") ||
    cmdLower.includes("server") ||
    cmdLower.includes("host") ||
    cmdLower.includes("gatsby") ||
    cmdLower.includes("astro");

  const hasServerIndicators =
    outputLower.includes("localhost") ||
    outputLower.includes("127.0.0.1") ||
    outputLower.includes("0.0.0.0") ||
    outputLower.includes("port ") ||
    outputLower.includes("port:") ||
    outputLower.includes("http://") ||
    outputLower.includes("https://") ||
    outputLower.includes("ready in") ||
    outputLower.includes("listening on") ||
    outputLower.includes("started") ||
    outputLower.includes("compiled successfully") ||
    outputLower.includes("server run");

  return hasDevCommand && hasServerIndicators;
}

export function normalizeDockerPath(p: string): string {
  let normalized = p.replace(/\\/g, "/");
  const winDriveRegex = /^([a-zA-Z]):\//;
  const match = winDriveRegex.exec(normalized);
  if (match) {
    const drive = match[1]!.toLowerCase();
    normalized = `/${drive}/${normalized.substring(3)}`;
  }
  return normalized;
}

export function getDockerImage(projectRoot: string, overrideImage?: string): string {
  if (overrideImage) return overrideImage;

  // Check workspace config first
  const configPath = join(projectRoot, ".agency", "config.json");
  if (existsSync(configPath)) {
    try {
      const config = JSON.parse(readFileSync(configPath, "utf8"));
      if (config.sandbox?.dockerImage) {
        return config.sandbox.dockerImage;
      }
    } catch {
      // ignore
    }
  }

  // Detect project type fallback
  if (existsSync(join(projectRoot, "package.json"))) {
    return "node:22-alpine";
  }
  if (
    existsSync(join(projectRoot, "requirements.txt")) ||
    existsSync(join(projectRoot, "pyproject.toml")) ||
    existsSync(join(projectRoot, "setup.py"))
  ) {
    return "python:3.12-alpine";
  }
  if (existsSync(join(projectRoot, "Cargo.toml"))) {
    return "rust:1.79-alpine";
  }
  if (existsSync(join(projectRoot, "pom.xml")) || existsSync(join(projectRoot, "build.gradle"))) {
    return "maven:3-eclipse-temurin-21-alpine";
  }
  return "node:22-alpine"; // fallback default
}

export async function isDockerAvailable(): Promise<boolean> {
  return new Promise((resolve) => {
    // Check if docker is available and running Linux containers
    const child = spawn("docker", ["info", "--format", "{{.OSType}}"], {
      stdio: ["ignore", "pipe", "ignore"],
      shell: true,
    });
    
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {}
      resolve(false);
    }, 3000);

    let output = "";
    child.stdout?.on("data", (chunk) => {
      output += chunk.toString();
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve(code === 0 && output.trim().toLowerCase() === "linux");
    });
    child.on("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}

export interface ActiveProcess {
  child: ChildProcess;
  cleanup?: () => void;
}

export const activeProcesses = new Set<ActiveProcess>();

let signalListenersRegistered = false;

export function registerSandboxCleanup(): void {
  if (signalListenersRegistered) return;
  signalListenersRegistered = true;

  const killAll = () => {
    const snapshot = Array.from(activeProcesses);
    for (const ref of snapshot) {
      try {
        if (ref.child.pid && !ref.child.killed) {
          if (process.platform === "win32") {
            spawnSync("taskkill", ["/F", "/T", "/PID", String(ref.child.pid)], { stdio: "ignore" });
          } else {
            try {
              process.kill(-ref.child.pid, "SIGKILL");
            } catch {
              ref.child.kill("SIGKILL");
            }
          }
        }
        if (ref.cleanup) {
          ref.cleanup();
        }
      } catch {
        // ignore
      }
    }
    activeProcesses.clear();
  };

  process.on("exit", killAll);
  process.on("SIGINT", () => {
    killAll();
    if (process.env.AGENCY_TUI !== "true") {
      process.exit(130);
    }
  });
  process.on("SIGTERM", () => {
    killAll();
    if (process.env.AGENCY_TUI !== "true") {
      process.exit(143);
    }
  });
}

export class NativeSandbox implements Sandbox {
  constructor(private options: SandboxOptions) {}

  async execute(command: string): Promise<SandboxResult> {
    registerSandboxCleanup();

    const envCopy = { ...process.env, ...this.options.env } as Record<string, string>;
    let proxy: EgressFilterProxy | null = null;

    if (!this.options.networkDisabled) {
      try {
        proxy = new EgressFilterProxy({
          projectRoot: this.options.projectRoot,
          onSecurityAlert: this.options.onSecurityAlert
        });
        const proxyPort = await proxy.start();
        const proxyUrl = `http://127.0.0.1:${proxyPort}`;
        envCopy["HTTP_PROXY"] = proxyUrl;
        envCopy["HTTPS_PROXY"] = proxyUrl;
        envCopy["http_proxy"] = proxyUrl;
        envCopy["https_proxy"] = proxyUrl;
        envCopy["ALL_PROXY"] = proxyUrl;
        envCopy["all_proxy"] = proxyUrl;
      } catch (err) {
        this.options.onSecurityAlert?.({
          action: "system:warning",
          payload: {
            message: `Security Warning: EgressFilterProxy failed to initialize (${err instanceof Error ? err.message : String(err)}). System is falling back to direct network mode.`
          }
        });
      }
    }

    return new Promise((resolve, reject) => {
      const pathSep = process.platform === "win32" ? ";" : ":";
      const localBin = join(this.options.projectRoot, "node_modules", ".bin");

      const pathKey = Object.keys(envCopy).find((k) => k.toUpperCase() === "PATH") || "PATH";

      const existingPath = envCopy[pathKey] || "";
      envCopy[pathKey] = existingPath
        ? `${localBin}${pathSep}${existingPath}`
        : localBin;

      this.options.onEvent?.({
        type: "started",
        timestamp: Date.now(),
        detail: `Starting native command: ${command}`
      });

      const jail = new ProcessJail();
      if (this.options.processMemoryLimit) {
        jail.setMemoryLimit(this.options.processMemoryLimit);
      }

      const child = spawn(command, {
        shell: true,
        cwd: this.options.projectRoot,
        env: envCopy,
        stdio: ["ignore", "pipe", "pipe"],
        detached: process.platform !== "win32"
      });

      if (child.pid) {
        jail.attachProcess(child.pid);
      }

      const processRef: ActiveProcess = {
        child,
        cleanup: () => {
          jail.dispose();
          if (proxy) {
            proxy.stop().catch(() => {});
          }
        }
      };
      activeProcesses.add(processRef);

      let timer: NodeJS.Timeout | null = null;
      let detachTimer: NodeJS.Timeout | null = null;
      let timedOut = false;
      let aborted = false;
      let isDetached = false;

      const cleanup = () => {
        if (timer) clearTimeout(timer);
        if (detachTimer) clearInterval(detachTimer);
        if (this.options.signal) {
          this.options.signal.removeEventListener("abort", onAbort);
        }
        activeProcesses.delete(processRef);
        jail.dispose();
        if (proxy) {
          proxy.stop().catch(() => {});
        }
      };

      const onAbort = () => {
        aborted = true;
        this.options.onEvent?.({
          type: "process-killed",
          timestamp: Date.now(),
          detail: "Process terminated due to abort signal"
        });
        jail.killAll();
        if (child.pid && !child.killed) {
          try {
            if (process.platform === "win32") {
              spawnSync("taskkill", ["/F", "/T", "/PID", String(child.pid)], { stdio: "ignore" });
            } else {
              try {
                process.kill(-child.pid, "SIGKILL");
              } catch {
                child.kill("SIGKILL");
              }
            }
          } catch {}
        }
        cleanup();
        reject(new Error("Aborted"));
      };

      if (this.options.signal) {
        if (this.options.signal.aborted) {
          onAbort();
          return;
        }
        this.options.signal.addEventListener("abort", onAbort);
      }

      const timeoutVal = this.options.timeout !== undefined ? this.options.timeout : 300_000;
      if (timeoutVal > 0) {
        timer = setTimeout(() => {
          timedOut = true;
          this.options.onEvent?.({
            type: "timeout",
            timestamp: Date.now(),
            detail: `Execution timed out after ${timeoutVal}ms`
          });
          jail.killAll();
          this.options.onEvent?.({
            type: "process-killed",
            timestamp: Date.now(),
            detail: "Process tree terminated due to timeout"
          });
        }, timeoutVal);
      }

      let stdout = "";
      let stderr = "";
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let stdoutTruncated = false;
      let stderrTruncated = false;

      const maxStdout = this.options.maxStdoutBytes ?? 50 * 1024 * 1024; // 50MB
      const maxStderr = this.options.maxStderrBytes ?? 10 * 1024 * 1024; // 10MB

      child.stdout?.on("data", (chunk: Buffer) => {
        if (stdoutTruncated) return;
        if (stdoutBytes + chunk.length > maxStdout) {
          stdoutTruncated = true;
          const allowed = maxStdout - stdoutBytes;
          if (allowed > 0) {
            stdout += chunk.slice(0, allowed).toString();
            stdoutBytes += allowed;
          }
          stdout += "\n[TRUNCATED stdout]";
          this.options.onEvent?.({
            type: "output-truncated",
            timestamp: Date.now(),
            detail: `Stdout exceeded limit of ${maxStdout} bytes`
          });
          child.stdout?.destroy();
        } else {
          stdout += chunk.toString();
          stdoutBytes += chunk.length;
        }
        if (!this.options.capture && !stdoutTruncated) {
          process.stdout.write(chunk);
        }
      });

      child.stderr?.on("data", (chunk: Buffer) => {
        if (stderrTruncated) return;
        if (stderrBytes + chunk.length > maxStderr) {
          stderrTruncated = true;
          const allowed = maxStderr - stderrBytes;
          if (allowed > 0) {
            stderr += chunk.slice(0, allowed).toString();
            stderrBytes += allowed;
          }
          stderr += "\n[TRUNCATED stderr]";
          this.options.onEvent?.({
            type: "output-truncated",
            timestamp: Date.now(),
            detail: `Stderr exceeded limit of ${maxStderr} bytes`
          });
          child.stderr?.destroy();
        } else {
          stderr += chunk.toString();
          stderrBytes += chunk.length;
        }
        if (!this.options.capture && !stderrTruncated) {
          process.stderr.write(chunk);
        }
      });

      const startCheckDelay = 1500;
      const checkInterval = 500;

      const runDetachCheck = () => {
        if (aborted || timedOut || child.killed || isDetached) return;

        if (isDevServerPattern(command, stdout, stderr)) {
          isDetached = true;
          if (detachTimer) clearInterval(detachTimer);

          // Discard subsequent logs to prevent memory leaks and EPIPE blockages
          child.stdout?.removeAllListeners("data");
          child.stderr?.removeAllListeners("data");
          child.stdout?.resume();
          child.stderr?.resume();

          // Clear timeout timer and abort listener
          if (timer) clearTimeout(timer);
          if (this.options.signal) {
            this.options.signal.removeEventListener("abort", onAbort);
          }

          this.options.onEvent?.({
            type: "completed",
            timestamp: Date.now(),
            detail: `Smart background detach: dev server detected and running in background.`
          });

          resolve({
            exitCode: 0,
            stdout: stdout + "\n[Detached into background as dev server]",
            stderr,
          });
        }
      };

      setTimeout(() => {
        if (!aborted && !timedOut && !child.killed && child.exitCode === null && !isDetached) {
          runDetachCheck();
          if (!aborted && !timedOut && !child.killed && child.exitCode === null && !isDetached) {
            detachTimer = setInterval(() => {
              runDetachCheck();
            }, checkInterval);
          }
        }
      }, startCheckDelay);

      child.on("error", (err) => {
        if (aborted) return;
        cleanup();
        reject(err);
      });

      child.on("close", (code: number | null) => {
        if (aborted) return;
        cleanup();
        this.options.onEvent?.({
          type: "completed",
          timestamp: Date.now(),
          detail: `Process completed with exit code ${code}`
        });
        resolve({
          exitCode: timedOut ? 124 : (code ?? 1),
          stdout,
          stderr,
          timedOut,
          stdoutTruncated,
          stderrTruncated,
        });
      });
    });
  }
}

export class DockerSandbox implements Sandbox {
  constructor(private options: SandboxOptions) {}

  async execute(command: string): Promise<SandboxResult> {
    registerSandboxCleanup();
    const dockerOk = await isDockerAvailable();
    if (!dockerOk) {
      throw new Error(
        "Docker daemon is unreachable. Cannot execute autonomously in a sandboxed container.\n\n" +
        "💡 Setup Guide:\n" +
        "  1. Ensure Docker Desktop is installed and running.\n" +
        "  2. Or, if you explicitly trust the workspace, run natively on the host using: --sandbox-mode native\n" +
        "     (Note: Native host execution requires Level 5 Privileged security capability)."
      );
    }

    const containerName = `agency-sandbox-${randomUUID()}`;
    const image = getDockerImage(this.options.projectRoot, this.options.image);
    const hostPath = normalizeDockerPath(this.options.projectRoot);
    const volumeMount = `${hostPath}:/workspace${this.options.readOnly ? ":ro" : ""}`;

    const args = ["run", "--rm", "--name", containerName, "-w", "/workspace", "-v", volumeMount];

    let proxy: EgressFilterProxy | null = null;
    let proxyUrl = "";

    if (!this.options.networkDisabled) {
      try {
        proxy = new EgressFilterProxy({
          projectRoot: this.options.projectRoot,
          onSecurityAlert: this.options.onSecurityAlert
        });
        const proxyPort = await proxy.start();
        proxyUrl = `http://host.docker.internal:${proxyPort}`;
      } catch (err) {
        this.options.onSecurityAlert?.({
          action: "system:warning",
          payload: {
            message: `Security Warning: EgressFilterProxy failed to initialize (${err instanceof Error ? err.message : String(err)}). System is falling back to direct network mode.`
          }
        });
      }
    }

    if (this.options.networkDisabled) {
      args.push("--network", "none");
    } else if (proxyUrl) {
      args.push("--add-host", "host.docker.internal:host-gateway");
      args.push("-e", `HTTP_PROXY=${proxyUrl}`);
      args.push("-e", `HTTPS_PROXY=${proxyUrl}`);
      args.push("-e", `http_proxy=${proxyUrl}`);
      args.push("-e", `https_proxy=${proxyUrl}`);
      args.push("-e", `ALL_PROXY=${proxyUrl}`);
      args.push("-e", `all_proxy=${proxyUrl}`);
    }

    if (this.options.memoryLimit) {
      args.push("-m", this.options.memoryLimit);
    }

    if (this.options.cpuLimit) {
      args.push("--cpus", this.options.cpuLimit);
    }

    if (this.options.env) {
      for (const [key, val] of Object.entries(this.options.env)) {
        args.push("-e", `${key}=${val}`);
      }
    }

    args.push(image, "sh", "-c", command);

    return new Promise((resolve, reject) => {
      const child = spawn("docker", args, {
        shell: true,
        stdio: ["ignore", "pipe", "pipe"],
      });

      let aborted = false;
      let timedOut = false;
      let timer: NodeJS.Timeout | null = null;
      let detachTimer: NodeJS.Timeout | null = null;
      let isDetached = false;

      const cleanup = () => {
        if (timer) clearTimeout(timer);
        if (detachTimer) clearInterval(detachTimer);
        if (this.options.signal) {
          this.options.signal.removeEventListener("abort", onAbort);
        }
        activeProcesses.delete(processRef);
        if (proxy) {
          proxy.stop().catch(() => {});
        }
      };

      const onAbort = () => {
        aborted = true;
        try {
          spawnSync("docker", ["rm", "-f", containerName], { stdio: "ignore" });
        } catch {}
        if (child.pid && !child.killed) {
          try {
            if (process.platform === "win32") {
              spawnSync("taskkill", ["/F", "/T", "/PID", String(child.pid)], { stdio: "ignore" });
            } else {
              try {
                process.kill(-child.pid, "SIGKILL");
              } catch {
                child.kill("SIGKILL");
              }
            }
          } catch {}
        }
        cleanup();
        reject(new Error("Aborted"));
      };

      if (this.options.signal) {
        if (this.options.signal.aborted) {
          onAbort();
          return;
        }
        this.options.signal.addEventListener("abort", onAbort);
      }

      const processRef: ActiveProcess = {
        child,
        cleanup: () => {
          try {
            spawnSync("docker", ["rm", "-f", containerName], { stdio: "ignore" });
          } catch {
            // ignore
          }
          if (proxy) {
            proxy.stop().catch(() => {});
          }
        }
      };
      activeProcesses.add(processRef);

      // Timeout — a hung container (one that is NOT a dev server and never exits)
      // must not run forever. The NativeSandbox had this; Docker silently ignored
      // `options.timeout`. On timeout we force-remove the container, kill the
      // docker client child, and resolve with exit 124 (mirrors native).
      const timeoutVal = this.options.timeout !== undefined ? this.options.timeout : 300_000;

      let stdout = "";
      let stderr = "";
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let stdoutTruncated = false;
      let stderrTruncated = false;

      // Output caps — an unbounded container log would grow memory without limit.
      const maxStdout = this.options.maxStdoutBytes ?? 50 * 1024 * 1024; // 50MB
      const maxStderr = this.options.maxStderrBytes ?? 10 * 1024 * 1024; // 10MB

      child.stdout?.on("data", (chunk: Buffer) => {
        if (stdoutTruncated) return;
        if (stdoutBytes + chunk.length > maxStdout) {
          stdoutTruncated = true;
          const allowed = maxStdout - stdoutBytes;
          if (allowed > 0) {
            stdout += chunk.slice(0, allowed).toString();
            stdoutBytes += allowed;
          }
          stdout += "\n[TRUNCATED stdout]";
          this.options.onEvent?.({
            type: "output-truncated",
            timestamp: Date.now(),
            detail: `Stdout exceeded limit of ${maxStdout} bytes`,
          });
          child.stdout?.destroy();
        } else {
          stdout += chunk.toString();
          stdoutBytes += chunk.length;
        }
        if (!this.options.capture && !stdoutTruncated) {
          process.stdout.write(chunk);
        }
      });

      child.stderr?.on("data", (chunk: Buffer) => {
        if (stderrTruncated) return;
        if (stderrBytes + chunk.length > maxStderr) {
          stderrTruncated = true;
          const allowed = maxStderr - stderrBytes;
          if (allowed > 0) {
            stderr += chunk.slice(0, allowed).toString();
            stderrBytes += allowed;
          }
          stderr += "\n[TRUNCATED stderr]";
          this.options.onEvent?.({
            type: "output-truncated",
            timestamp: Date.now(),
            detail: `Stderr exceeded limit of ${maxStderr} bytes`,
          });
          child.stderr?.destroy();
        } else {
          stderr += chunk.toString();
          stderrBytes += chunk.length;
        }
        if (!this.options.capture && !stderrTruncated) {
          process.stderr.write(chunk);
        }
      });

      if (timeoutVal > 0) {
        timer = setTimeout(() => {
          timedOut = true;
          this.options.onEvent?.({
            type: "timeout",
            timestamp: Date.now(),
            detail: `Execution timed out after ${timeoutVal}ms`,
          });
          try {
            spawnSync("docker", ["rm", "-f", containerName], { stdio: "ignore" });
          } catch {}
          if (child.pid && !child.killed) {
            try {
              if (process.platform === "win32") {
                spawnSync("taskkill", ["/F", "/T", "/PID", String(child.pid)], { stdio: "ignore" });
              } else {
                try {
                  process.kill(-child.pid, "SIGKILL");
                } catch {
                  child.kill("SIGKILL");
                }
              }
            } catch {}
          }
          this.options.onEvent?.({
            type: "process-killed",
            timestamp: Date.now(),
            detail: "Container force-removed due to timeout",
          });
          cleanup();
          resolve({ exitCode: 124, stdout, stderr, timedOut: true, stdoutTruncated, stderrTruncated });
        }, timeoutVal);
      }

      const startCheckDelay = 1500;
      const checkInterval = 500;

      const runDetachCheck = () => {
        if (aborted || timedOut || child.killed || isDetached) return;

        if (isDevServerPattern(command, stdout, stderr)) {
          isDetached = true;
          if (detachTimer) clearInterval(detachTimer);
          // A backgrounded dev server is expected to keep running → cancel the
          // timeout so it isn't force-removed after timeoutVal.
          if (timer) clearTimeout(timer);

          // Discard subsequent logs to prevent memory leaks and EPIPE blockages
          child.stdout?.removeAllListeners("data");
          child.stderr?.removeAllListeners("data");
          child.stdout?.resume();
          child.stderr?.resume();

          if (this.options.signal) {
            this.options.signal.removeEventListener("abort", onAbort);
          }

          this.options.onEvent?.({
            type: "completed",
            timestamp: Date.now(),
            detail: `Smart background detach (Docker): dev server detected and running in background.`
          });

          resolve({
            exitCode: 0,
            stdout: stdout + "\n[Detached into background as dev server (Docker)]",
            stderr,
          });
        }
      };

      setTimeout(() => {
        if (!aborted && !child.killed && child.exitCode === null && !isDetached) {
          runDetachCheck();
          if (!aborted && !child.killed && child.exitCode === null && !isDetached) {
            detachTimer = setInterval(() => {
              runDetachCheck();
            }, checkInterval);
          }
        }
      }, startCheckDelay);

      child.on("error", (err) => {
        if (aborted) return;
        cleanup();
        reject(err);
      });

      child.on("close", (code: number | null) => {
        if (aborted || timedOut) return;
        cleanup();
        resolve({
          exitCode: code ?? 1,
          stdout,
          stderr,
          stdoutTruncated,
          stderrTruncated,
        });
      });
    });
  }
}
