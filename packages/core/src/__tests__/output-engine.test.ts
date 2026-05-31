import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { OutputEngine } from "../output/output-engine.js";

describe("OutputEngine Subsystem", () => {
  let stdoutWriteSpy: any;
  let stderrWriteSpy: any;

  beforeEach(() => {
    stdoutWriteSpy = vi.spyOn(process.stdout, "write").mockImplementation((() => true) as any);
    stderrWriteSpy = vi.spyOn(process.stderr, "write").mockImplementation((() => true) as any);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    OutputEngine.reset();
  });

  it("should enforce singleton configuration and instantiation", () => {
    const engine1 = OutputEngine.shared({ surface: "human", quiet: false });
    const engine2 = OutputEngine.shared();
    expect(engine1).toBe(engine2);

    engine2.configure({ surface: "json" });
    // Verify configuration state update
    const engine3 = OutputEngine.shared({ surface: "human" });
    expect(engine3).toBe(engine1);
  });

  it("should format and emit standard operational events in human mode", () => {
    const engine = new OutputEngine({ surface: "human" });
    engine.emit({ source: "planner", message: "parsing instruction checklist" });

    expect(stdoutWriteSpy).toHaveBeenCalled();
    const output = stdoutWriteSpy.mock.calls[0][0];
    expect(output).toContain("[planner]");
    expect(output).toContain("parsing instruction checklist");
  });

  it("should format and emit standard operational events in json mode", () => {
    const engine = new OutputEngine({ surface: "json" });
    engine.emit({ source: "planner", message: "parsing instruction checklist" });

    expect(stdoutWriteSpy).toHaveBeenCalled();
    const output = stdoutWriteSpy.mock.calls[0][0];
    const parsed = JSON.parse(output.trim());
    expect(parsed.source).toBe("planner");
    expect(parsed.message).toBe("parsing instruction checklist");
  });

  it("should format active execution phases", () => {
    const engine = new OutputEngine({ surface: "human" });
    engine.phase("preflight validation", { target: "AuthService" });

    expect(stdoutWriteSpy).toHaveBeenCalled();
    const output = stdoutWriteSpy.mock.calls[0][0];
    expect(output).toContain("preflight validation");
    expect(output).toContain("target=AuthService");
  });

  it("should format key-value result sets", () => {
    const engine = new OutputEngine({ surface: "human" });
    engine.result([
      { key: "Status", value: "Verified" },
      { key: "Code", value: "200" },
    ]);

    expect(stdoutWriteSpy).toHaveBeenCalled();
    const output = stdoutWriteSpy.mock.calls[0][0];
    expect(output).toContain("Status");
    expect(output).toContain("Verified");
    expect(output).toContain("Code");
    expect(output).toContain("200");
  });

  it("should print structured, calm failure logs to stderr", () => {
    const engine = new OutputEngine({ surface: "human" });
    engine.failure({
      title: "Dependency resolution failed",
      consequence: "Staging build halted",
      recovery: "Inspect yarn workspaces lockfile configuration",
    });

    expect(stderrWriteSpy).toHaveBeenCalled();
    const output = stderrWriteSpy.mock.calls[0][0];
    expect(output).toContain("Dependency resolution failed");
    expect(output).toContain("Staging build halted");
    expect(output).toContain("Inspect yarn workspaces lockfile configuration");
  });

  it("should print clean structured patches", () => {
    const engine = new OutputEngine({ surface: "human" });
    engine.patch({
      title: "Update configurations",
      changes: [
        { action: "MODIFY", target: "packages/core/src/index.ts" },
        { action: "ADD", target: "packages/core/src/output/output-engine.ts" },
      ],
      risk: "LOW",
      confidence: "HIGH",
    });

    expect(stdoutWriteSpy).toHaveBeenCalled();
    const output = stdoutWriteSpy.mock.calls[0][0];
    expect(output).toContain("Update configurations");
    expect(output).toContain("[MODIFY] packages/core/src/index.ts");
    expect(output).toContain("[ADD] packages/core/src/output/output-engine.ts");
  });

  it("should align and print tables beautifully", () => {
    const engine = new OutputEngine({ surface: "human" });
    engine.table(["ID", "Name", "Score"], [["1", "Alpha", "95"], ["2", "Beta", "88"]]);

    expect(stdoutWriteSpy).toHaveBeenCalled();
    const output = stdoutWriteSpy.mock.calls[0][0];
    expect(output).toContain("ID");
    expect(output).toContain("Alpha");
    expect(output).toContain("Beta");
    expect(output).toContain("95");
  });

  it("should handle worker status display cleanly", () => {
    const engine = new OutputEngine({ surface: "human" });
    engine.worker({
      workerId: "worker.auth-test",
      status: "running",
      task: "testing session manager",
      elapsedMs: 2500,
    });

    expect(stdoutWriteSpy).toHaveBeenCalled();
    const output = stdoutWriteSpy.mock.calls[0][0];
    expect(output).toContain("[worker.auth-test]");
    expect(output).toContain("running");
    expect(output).toContain("testing session manager");
    expect(output).toContain("2.5s");
  });

  it("should render clean, structured badges", () => {
    const engine = new OutputEngine({ surface: "human" });
    engine.trust({
      risk: "LOW",
      confidence: "HIGH",
      validation: "PASSED",
      rollbackReady: true,
    });

    expect(stdoutWriteSpy).toHaveBeenCalled();
    const output = stdoutWriteSpy.mock.calls[0][0];
    expect(output).toContain("risk: LOW");
    expect(output).toContain("confidence: HIGH");
    expect(output).toContain("validation: PASSED");
    expect(output).toContain("rollback: ready");
  });
});
