import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { runShellCommand } from "../terminal/sandbox.js";
import { SecurityLevel } from "@agency/security";

vi.mock("@agency/security", async (importOriginal) => {
  const original = await importOriginal<typeof import("@agency/security")>();
  
  class MockDockerSandbox {
    opts: any;
    execute = vi.fn();
    constructor(opts: any) {
      this.opts = opts;
      this.execute.mockResolvedValue({
        exitCode: 0,
        stdout: `mocked docker stdout for ${opts.image}`,
        stderr: "",
      });
      (globalThis as any).__dockerInstances = (globalThis as any).__dockerInstances || [];
      (globalThis as any).__dockerInstances.push(this);
    }
  }

  class MockNativeSandbox {
    opts: any;
    execute = vi.fn();
    constructor(opts: any) {
      this.opts = opts;
      this.execute.mockResolvedValue({
        exitCode: 0,
        stdout: "mocked native stdout",
        stderr: "",
      });
      (globalThis as any).__nativeInstances = (globalThis as any).__nativeInstances || [];
      (globalThis as any).__nativeInstances.push(this);
    }
  }

  return {
    ...original,
    DockerSandbox: MockDockerSandbox,
    NativeSandbox: MockNativeSandbox,
  };
});

describe("runShellCommand Sandbox Routing", () => {
  beforeEach(() => {
    (globalThis as any).__dockerInstances = [];
    (globalThis as any).__nativeInstances = [];
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("should route to NativeSandbox by default", async () => {
    const result = await runShellCommand("d:\\project", "echo hello", {
      yes: true,
      capture: true,
    });

    expect(result.stdout).toBe("mocked native stdout");
    
    const dockerInstances = (globalThis as any).__dockerInstances;
    expect(dockerInstances.length).toBe(0);
    
    const nativeInstances = (globalThis as any).__nativeInstances;
    expect(nativeInstances.length).toBe(1);
    expect(nativeInstances[0].opts).toEqual(expect.objectContaining({
      projectRoot: "d:\\project",
      capture: true,
    }));
  });

  it("should route to DockerSandbox when sandboxMode is docker", async () => {
    const result = await runShellCommand("d:\\project", "echo hello", {
      yes: true,
      capture: true,
      sandboxMode: "docker",
      dockerImage: "node:latest",
    });

    expect(result.stdout).toBe("mocked docker stdout for node:latest");
    
    const dockerInstances = (globalThis as any).__dockerInstances;
    expect(dockerInstances.length).toBe(1);
    expect(dockerInstances[0].opts).toEqual(expect.objectContaining({
      projectRoot: "d:\\project",
      image: "node:latest",
      capture: true,
    }));

    const nativeInstances = (globalThis as any).__nativeInstances;
    expect(nativeInstances.length).toBe(0);
  });

  it("should derive networkDisabled and readOnly constraints from maxSecurityLevel", async () => {
    // Under Level3_WorkspaceWrite:
    // maxSecurityLevel = Level3_WorkspaceWrite (< Level4_Network) => networkDisabled should be true
    // maxSecurityLevel = Level3_WorkspaceWrite (>= Level3_WorkspaceWrite) => readOnly should be false
    await runShellCommand("d:\\project", "echo hello", {
      yes: true,
      sandboxMode: "docker",
      maxSecurityLevel: SecurityLevel.Level3_WorkspaceWrite,
    });

    let dockerInstances = (globalThis as any).__dockerInstances;
    expect(dockerInstances.length).toBe(1);
    expect(dockerInstances[0].opts).toEqual(expect.objectContaining({
      networkDisabled: true,
      readOnly: false,
    }));

    // Under Level2_ReadOnly:
    // maxSecurityLevel = Level2_ReadOnly (< Level4_Network) => networkDisabled should be true
    // maxSecurityLevel = Level2_ReadOnly (< Level3_WorkspaceWrite) => readOnly should be true
    await runShellCommand("d:\\project", "echo hello", {
      yes: true,
      sandboxMode: "docker",
      maxSecurityLevel: SecurityLevel.Level2_ReadOnly,
    });

    dockerInstances = (globalThis as any).__dockerInstances;
    expect(dockerInstances.length).toBe(2);
    expect(dockerInstances[1].opts).toEqual(expect.objectContaining({
      networkDisabled: true,
      readOnly: true,
    }));

    // Under Level4_Network:
    // maxSecurityLevel = Level4_Network (>= Level4_Network) => networkDisabled should be false
    // maxSecurityLevel = Level4_Network (>= Level3_WorkspaceWrite) => readOnly should be false
    await runShellCommand("d:\\project", "echo hello", {
      yes: true,
      sandboxMode: "docker",
      maxSecurityLevel: SecurityLevel.Level4_Network,
    });

    dockerInstances = (globalThis as any).__dockerInstances;
    expect(dockerInstances.length).toBe(3);
    expect(dockerInstances[2].opts).toEqual(expect.objectContaining({
      networkDisabled: false,
      readOnly: false,
    }));
  });
});
