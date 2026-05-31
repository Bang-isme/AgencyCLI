import { describe, it, expect } from "vitest";
import { NativeSandbox } from "@agency/security";

describe("Phase 4: Isolated Native Sandbox Boundary Integration Tests", () => {
  it("should respect execution timeout constraints and return timedOut status", async () => {
    const sandbox = new NativeSandbox({
      projectRoot: process.cwd(),
      timeout: 100, // 100ms timeout
      capture: true,
    });

    const startTime = Date.now();
    // Running a sleep command longer than timeout
    const result = await sandbox.execute(
      process.platform === "win32" ? "powershell -Command Start-Sleep -Seconds 5" : "sleep 5"
    );
    const duration = Date.now() - startTime;

    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBe(124);
    expect(duration).toBeLessThan(3000); // Should terminate way before 5 seconds
  });

  it("should enforce stdout size limits and truncate excessive outputs", async () => {
    const sandbox = new NativeSandbox({
      projectRoot: process.cwd(),
      maxStdoutBytes: 50, // very small stdout limit
      capture: true,
    });

    // Outputting a string of 100 characters
    const text = "A".repeat(100);
    const result = await sandbox.execute(
      process.platform === "win32" ? `powershell -Command Write-Output '${text}'` : `echo ${text}`
    );

    expect(result.stdoutTruncated).toBe(true);
    expect(result.stdout.length).toBeLessThan(100);
    expect(result.stdout).toContain("[TRUNCATED stdout]");
  });

  it("should immediately terminate running command processes when abort signal is triggered", async () => {
    const controller = new AbortController();
    const sandbox = new NativeSandbox({
      projectRoot: process.cwd(),
      signal: controller.signal,
      capture: true,
    });

    const runPromise = sandbox.execute(
      process.platform === "win32" ? "powershell -Command Start-Sleep -Seconds 10" : "sleep 10"
    );

    // Trigger abort after 100ms
    setTimeout(() => {
      controller.abort();
    }, 100);

    await expect(runPromise).rejects.toThrow("Aborted");
  });
});
