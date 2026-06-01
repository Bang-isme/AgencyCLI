import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import * as childProcess from "node:child_process";
import { NativeSandbox, DockerSandbox, isDockerAvailable, normalizeDockerPath, getDockerImage } from "../sandbox.js";
import { Readable } from "node:stream";

vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:child_process")>();
  return {
    ...original,
    spawn: vi.fn(),
  };
});

describe("Sandbox Suite", () => {
  const mockSpawn = vi.mocked(childProcess.spawn);

  beforeEach(() => {
    mockSpawn.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("normalizeDockerPath", () => {
    it("should replace backslashes with forward slashes and format Windows drive letters to POSIX", () => {
      expect(normalizeDockerPath("C:\\Users\\test")).toBe("/c/Users/test");
      expect(normalizeDockerPath("d:\\AgencyCLI\\packages")).toBe("/d/AgencyCLI/packages");
    });
  });

  describe("getDockerImage", () => {
    it("should return overrideImage if provided", () => {
      expect(getDockerImage("/some/root", "my-custom-image")).toBe("my-custom-image");
    });

    it("should detect project type dynamically", () => {
      const fs = require("node:fs");
      const os = require("node:os");
      const path = require("node:path");
      
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agency-sec-test-"));
      
      // Default fallback
      expect(getDockerImage(tmp)).toBe("node:22-alpine");

      // Python detection
      fs.writeFileSync(path.join(tmp, "requirements.txt"), "");
      expect(getDockerImage(tmp)).toBe("python:3.12-alpine");
      fs.unlinkSync(path.join(tmp, "requirements.txt"));

      // Rust detection
      fs.writeFileSync(path.join(tmp, "Cargo.toml"), "");
      expect(getDockerImage(tmp)).toBe("rust:1.79-alpine");
      fs.unlinkSync(path.join(tmp, "Cargo.toml"));

      // Config.json detection
      const agencyDir = path.join(tmp, ".agency");
      fs.mkdirSync(agencyDir, { recursive: true });
      fs.writeFileSync(path.join(agencyDir, "config.json"), JSON.stringify({ sandbox: { dockerImage: "custom-img" } }));
      expect(getDockerImage(tmp)).toBe("custom-img");

      fs.rmSync(tmp, { recursive: true, force: true });
    });
  });

  describe("isDockerAvailable", () => {
    it("should return true when docker info exits with 0", async () => {
      const mockProcess = {
        on: vi.fn((event: string, cb: any) => {
          if (event === "close") {
            setTimeout(() => cb(0), 10);
          }
          return mockProcess;
        }),
      };
      mockSpawn.mockReturnValue(mockProcess as any);

      const available = await isDockerAvailable();
      expect(available).toBe(true);
      expect(mockSpawn).toHaveBeenCalledWith("docker", ["info"], expect.any(Object));
    });

    it("should return false when docker info exits with non-zero code", async () => {
      const mockProcess = {
        on: vi.fn((event: string, cb: any) => {
          if (event === "close") {
            setTimeout(() => cb(1), 10);
          }
          return mockProcess;
        }),
      };
      mockSpawn.mockReturnValue(mockProcess as any);

      const available = await isDockerAvailable();
      expect(available).toBe(false);
    });

    it("should return false when docker info fails to spawn", async () => {
      const mockProcess = {
        on: vi.fn((event: string, cb: any) => {
          if (event === "error") {
            setTimeout(() => cb(new Error("Spawn error")), 10);
          }
          return mockProcess;
        }),
      };
      mockSpawn.mockReturnValue(mockProcess as any);

      const available = await isDockerAvailable();
      expect(available).toBe(false);
    });
  });

  describe("NativeSandbox", () => {
    it("should execute natively and collect stdout/stderr", async () => {
      const stdoutStream = new Readable({ read() {} });
      const stderrStream = new Readable({ read() {} });
      const mockProcess = {
        stdout: stdoutStream,
        stderr: stderrStream,
        on: vi.fn((event: string, cb: any) => {
          if (event === "close") {
            setTimeout(() => cb(0), 10);
          }
          return mockProcess;
        }),
      };
      mockSpawn.mockReturnValue(mockProcess as any);

      const sandbox = new NativeSandbox({
        projectRoot: "d:\\test-project",
        env: { CUSTOM_VAR: "value" },
        capture: true,
      });

      const executePromise = sandbox.execute("echo test");

      stdoutStream.push("hello stdout");
      stdoutStream.push(null);
      stderrStream.push("hello stderr");
      stderrStream.push(null);

      const result = await executePromise;

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("hello stdout");
      expect(result.stderr).toBe("hello stderr");
      expect(mockSpawn).toHaveBeenCalledWith("echo test", expect.objectContaining({
        cwd: "d:\\test-project",
        shell: true,
        env: expect.objectContaining({ CUSTOM_VAR: "value" }),
      }));
    });

    it("should kill process after timeout", async () => {
      const stdoutStream = new Readable({ read() {} });
      const stderrStream = new Readable({ read() {} });
      let closeCb: any = null;
      const mockProcess = {
        pid: 1234,
        stdout: stdoutStream,
        stderr: stderrStream,
        on: vi.fn((event: string, cb: any) => {
          if (event === "close") {
            closeCb = cb;
          }
          return mockProcess;
        }),
      };
      mockSpawn.mockReturnValue(mockProcess as any);

      const { ProcessJail } = await import("../process-jail.js");
      const spyKill = vi.spyOn(ProcessJail.prototype, "killAll").mockImplementation(() => {
        if (closeCb) {
          setTimeout(() => closeCb(null), 10);
        }
      });

      const events: any[] = [];
      const sandbox = new NativeSandbox({
        projectRoot: "d:\\test-project",
        timeout: 50,
        capture: true,
        onEvent: (ev) => events.push(ev),
      });

      const result = await sandbox.execute("sleep 10");
      expect(result.timedOut).toBe(true);
      expect(result.exitCode).toBe(124);
      expect(events.some(e => e.type === "timeout")).toBe(true);
      expect(events.some(e => e.type === "process-killed")).toBe(true);

      spyKill.mockRestore();
    });

    it("should truncate stdout when exceeding maxStdoutBytes", async () => {
      const stdoutStream = new Readable({ read() {} });
      const stderrStream = new Readable({ read() {} });
      const mockProcess = {
        pid: 1234,
        stdout: stdoutStream,
        stderr: stderrStream,
        on: vi.fn((event: string, cb: any) => {
          if (event === "close") {
            setTimeout(() => cb(0), 10);
          }
          return mockProcess;
        }),
      };
      mockSpawn.mockReturnValue(mockProcess as any);

      const events: any[] = [];
      const sandbox = new NativeSandbox({
        projectRoot: "d:\\test-project",
        maxStdoutBytes: 10,
        capture: true,
        onEvent: (ev) => events.push(ev),
      });

      const executePromise = sandbox.execute("echo test");
      stdoutStream.push("1234567890abcdef");
      stdoutStream.push(null);

      const result = await executePromise;
      expect(result.stdoutTruncated).toBe(true);
      expect(result.stdout).toContain("[TRUNCATED stdout]");
      expect(result.stdout.slice(0, 10)).toBe("1234567890");
      expect(events.some(e => e.type === "output-truncated")).toBe(true);
    });

    it("should truncate stderr when exceeding maxStderrBytes", async () => {
      const stdoutStream = new Readable({ read() {} });
      const stderrStream = new Readable({ read() {} });
      const mockProcess = {
        pid: 1234,
        stdout: stdoutStream,
        stderr: stderrStream,
        on: vi.fn((event: string, cb: any) => {
          if (event === "close") {
            setTimeout(() => cb(0), 10);
          }
          return mockProcess;
        }),
      };
      mockSpawn.mockReturnValue(mockProcess as any);

      const events: any[] = [];
      const sandbox = new NativeSandbox({
        projectRoot: "d:\\test-project",
        maxStderrBytes: 5,
        capture: true,
        onEvent: (ev) => events.push(ev),
      });

      const executePromise = sandbox.execute("echo test");
      stderrStream.push("err12345");
      stderrStream.push(null);

      const result = await executePromise;
      expect(result.stderrTruncated).toBe(true);
      expect(result.stderr).toContain("[TRUNCATED stderr]");
      expect(result.stderr.slice(0, 5)).toBe("err12");
      expect(events.some(e => e.type === "output-truncated")).toBe(true);
    });

    it("should emit started and completed events", async () => {
      const stdoutStream = new Readable({ read() {} });
      const stderrStream = new Readable({ read() {} });
      const mockProcess = {
        pid: 1234,
        stdout: stdoutStream,
        stderr: stderrStream,
        on: vi.fn((event: string, cb: any) => {
          if (event === "close") {
            setTimeout(() => cb(0), 5);
          }
          return mockProcess;
        }),
      };
      mockSpawn.mockReturnValue(mockProcess as any);

      const events: any[] = [];
      const sandbox = new NativeSandbox({
        projectRoot: "d:\\test-project",
        capture: true,
        onEvent: (ev) => events.push(ev),
      });

      await sandbox.execute("echo hello");
      expect(events.some(e => e.type === "started")).toBe(true);
      expect(events.some(e => e.type === "completed")).toBe(true);
    });
  });

  describe("DockerSandbox", () => {
    it("should throw error if Docker is unavailable", async () => {
      // Mock Docker not available
      const mockProcess = {
        on: vi.fn((event: string, cb: any) => {
          if (event === "close") {
            setTimeout(() => cb(1), 10);
          }
          return mockProcess;
        }),
      };
      mockSpawn.mockReturnValue(mockProcess as any);

      const sandbox = new DockerSandbox({ projectRoot: "d:\\test-project" });
      await expect(sandbox.execute("node -v")).rejects.toThrow(
        "Docker daemon is unreachable. Cannot execute autonomously in a sandboxed container."
      );
    });

    it("should construct Docker run command with correct arguments", async () => {
      // First mock isDockerAvailable (returns true / exit code 0)
      // Second mock is the docker run command itself
      let callCount = 0;
      const stdoutStream = new Readable({ read() {} });
      const stderrStream = new Readable({ read() {} });

      const mockProcessDockerInfo = {
        on: vi.fn((event: string, cb: any) => {
          if (event === "close") {
            setTimeout(() => cb(0), 5);
          }
          return mockProcessDockerInfo;
        }),
      };

      const mockProcessDockerRun = {
        stdout: stdoutStream,
        stderr: stderrStream,
        on: vi.fn((event: string, cb: any) => {
          if (event === "close") {
            setTimeout(() => cb(0), 5);
          }
          return mockProcessDockerRun;
        }),
      };

      mockSpawn.mockImplementation((cmd, args) => {
        callCount++;
        if (callCount === 1) {
          return mockProcessDockerInfo as any;
        } else {
          return mockProcessDockerRun as any;
        }
      });

      const sandbox = new DockerSandbox({
        projectRoot: "d:\\test-project",
        image: "custom-node:22",
        networkDisabled: true,
        readOnly: true,
        memoryLimit: "256m",
        cpuLimit: "0.5",
        env: { FOO: "bar" },
        capture: true,
      });

      const executePromise = sandbox.execute("npm install");

      stdoutStream.push("installed");
      stdoutStream.push(null);
      stderrStream.push(null);

      const result = await executePromise;

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("installed");
      expect(mockSpawn).toHaveBeenCalledTimes(2);

      // Verify the second call is the docker run command with proper flags
      const runCall = mockSpawn.mock.calls[1];
      expect(runCall[0]).toBe("docker");
      const runArgs = runCall[1] as string[];
      expect(runArgs).toContain("run");
      expect(runArgs).toContain("--rm");
      expect(runArgs).toContain("-w");
      expect(runArgs).toContain("/workspace");
      expect(runArgs).toContain("-v");
      expect(runArgs).toContain("/d/test-project:/workspace:ro");
      expect(runArgs).toContain("--network");
      expect(runArgs).toContain("none");
      expect(runArgs).toContain("-m");
      expect(runArgs).toContain("256m");
      expect(runArgs).toContain("--cpus");
      expect(runArgs).toContain("0.5");
      expect(runArgs).toContain("-e");
      expect(runArgs).toContain("FOO=bar");
      expect(runArgs).toContain("custom-node:22");
      expect(runArgs).toContain("sh");
      expect(runArgs).toContain("-c");
      expect(runArgs).toContain("npm install");
    });

    it("times out a hung container with exit 124 (Docker honours options.timeout like native)", async () => {
      // docker info → exit 0; docker run → a child that never closes (hung).
      let callCount = 0;
      const stdoutStream = new Readable({ read() {} });
      const stderrStream = new Readable({ read() {} });
      const dockerInfo = {
        on: vi.fn((event: string, cb: any) => {
          if (event === "close") setTimeout(() => cb(0), 5);
          return dockerInfo;
        }),
      };
      const dockerRun = {
        stdout: stdoutStream,
        stderr: stderrStream,
        killed: false,
        on: vi.fn(() => dockerRun), // never emits close → hung
      };
      mockSpawn.mockImplementation(() => {
        callCount++;
        return (callCount === 1 ? dockerInfo : dockerRun) as any;
      });

      const events: any[] = [];
      const sandbox = new DockerSandbox({
        projectRoot: "d:\\test-project",
        capture: true,
        networkDisabled: true, // no egress proxy port to bind in the test
        timeout: 50,
        onEvent: (ev) => events.push(ev),
      });

      const result = await sandbox.execute("sleep 999");
      expect(result.timedOut).toBe(true);
      expect(result.exitCode).toBe(124);
      expect(events.some((e) => e.type === "timeout")).toBe(true);
    });

    it("truncates container stdout beyond maxStdoutBytes", async () => {
      let callCount = 0;
      const stdoutStream = new Readable({ read() {} });
      const stderrStream = new Readable({ read() {} });
      const dockerInfo = {
        on: vi.fn((event: string, cb: any) => {
          if (event === "close") setTimeout(() => cb(0), 5);
          return dockerInfo;
        }),
      };
      let closeCb: any = null;
      const dockerRun = {
        stdout: stdoutStream,
        stderr: stderrStream,
        killed: false,
        on: vi.fn((event: string, cb: any) => {
          if (event === "close") closeCb = cb;
          return dockerRun;
        }),
      };
      mockSpawn.mockImplementation(() => {
        callCount++;
        return (callCount === 1 ? dockerInfo : dockerRun) as any;
      });

      const events: any[] = [];
      const sandbox = new DockerSandbox({
        projectRoot: "d:\\test-project",
        capture: true,
        networkDisabled: true,
        maxStdoutBytes: 10,
        timeout: 0, // disable timeout for this test
        onEvent: (ev) => events.push(ev),
      });

      const executePromise = sandbox.execute("cat bigfile");
      stdoutStream.push("1234567890abcdef"); // 16 bytes > 10
      setTimeout(() => closeCb?.(0), 10);

      const result = await executePromise;
      expect(result.stdoutTruncated).toBe(true);
      expect(result.stdout).toContain("[TRUNCATED stdout]");
      expect(result.stdout.slice(0, 10)).toBe("1234567890");
      expect(events.some((e) => e.type === "output-truncated")).toBe(true);
    });
  });
});
