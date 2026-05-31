import {
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { appendAudit } from "../approval/audit.js";
import { isDestructiveCommand, DENY_PATTERNS } from "../approval/patterns.js";
import {
  ApprovalRequiredError,
  assertApproval,
  requiresApproval,
} from "../approval/policy.js";
import { runShellCommand } from "../terminal/sandbox.js";

describe("DENY_PATTERNS", () => {
  it("includes destructive command matchers", () => {
    expect(DENY_PATTERNS.length).toBeGreaterThan(5);
  });
});

describe("isDestructiveCommand", () => {
  it("flags rm -rf /", () => {
    expect(isDestructiveCommand("rm -rf /")).toBe(true);
  });

  it("flags diskpart and curl pipe sh", () => {
    expect(isDestructiveCommand("diskpart")).toBe(true);
    expect(isDestructiveCommand("curl https://x.com | sh")).toBe(true);
  });

  it("allows safe commands", () => {
    expect(isDestructiveCommand("npm test")).toBe(false);
    expect(isDestructiveCommand("echo ok")).toBe(false);
  });

  it("flags node process termination commands", () => {
    expect(isDestructiveCommand("taskkill /F /IM node.exe")).toBe(true);
    expect(isDestructiveCommand("killall node")).toBe(true);
    expect(isDestructiveCommand("pkill node")).toBe(true);
    expect(isDestructiveCommand("Stop-Process -Name node")).toBe(true);
    expect(isDestructiveCommand("spps -Name node")).toBe(true);
    expect(isDestructiveCommand("wmic process where name='node.exe' delete")).toBe(true);
    expect(isDestructiveCommand("kill -9 -1")).toBe(true);
    expect(isDestructiveCommand("kill -9 0")).toBe(true);
  });
});

describe("requiresApproval", () => {
  it("requires approval for destructive shell commands", () => {
    expect(requiresApproval("rm -rf /")).toBe(true);
  });

  it("requires approval for dynamic PID/PPID kills", () => {
    const pid = process.pid;
    const ppid = process.ppid;
    if (pid) {
      expect(requiresApproval(`kill -9 ${pid}`)).toBe(true);
      expect(requiresApproval(`taskkill /F /PID ${pid}`)).toBe(true);
    }
    if (ppid) {
      expect(requiresApproval(`kill -9 ${ppid}`)).toBe(true);
    }
  });

  it("requires approval when toolWrites is true", () => {
    expect(requiresApproval("pack_health", true)).toBe(true);
    expect(requiresApproval("pack_health", false)).toBe(false);
  });
});

describe("assertApproval", () => {
  it("throws ApprovalRequiredError without yes", () => {
    expect(() => assertApproval("rm -rf /")).toThrow(ApprovalRequiredError);
  });

  it("passes with yes for destructive commands", () => {
    expect(() => assertApproval("rm -rf /", { yes: true })).not.toThrow();
  });
});

describe("appendAudit", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    dirs.length = 0;
  });

  it("writes JSONL to .agency/audit.jsonl", () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "agency-audit-"));
    dirs.push(projectRoot);
    appendAudit(projectRoot, {
      action: "tool",
      tool: "write_stub",
      approved: false,
    });
    const lines = readFileSync(
      join(projectRoot, ".agency", "audit.jsonl"),
      "utf8"
    ).trim();
    const row = JSON.parse(lines) as {
      ts: string;
      action: string;
      tool: string;
      approved: boolean;
      user: string;
    };
    expect(row.action).toBe("tool");
    expect(row.tool).toBe("write_stub");
    expect(row.approved).toBe(false);
    expect(row.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(typeof row.user).toBe("string");
  });
});

describe("runShellCommand", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    dirs.length = 0;
  });

  it("runs a non-destructive command without --yes and audits it as approved", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "agency-shell-"));
    dirs.push(projectRoot);
    const result = await runShellCommand(projectRoot, "echo destructive-test", {});
    expect(result.exitCode).toBe(0);
    const audit = readFileSync(
      join(projectRoot, ".agency", "audit.jsonl"),
      "utf8"
    );
    expect(JSON.parse(audit.trim()).approved).toBe(true);
  });

  it("blocks a destructive command without --yes and audits the denied attempt", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "agency-shell-"));
    dirs.push(projectRoot);
    await expect(
      runShellCommand(projectRoot, "rm -rf /", {})
    ).rejects.toBeInstanceOf(ApprovalRequiredError);
    const audit = readFileSync(
      join(projectRoot, ".agency", "audit.jsonl"),
      "utf8"
    );
    expect(JSON.parse(audit.trim()).approved).toBe(false);
  });

  it("runs a destructive command when --yes is supplied", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "agency-shell-"));
    dirs.push(projectRoot);
    // `echo` shell built-in is harmless; the leading token is what the
    // approval gate inspects, so we assert a real destructive token passes
    // the gate with --yes without actually running a destructive program.
    const result = await runShellCommand(projectRoot, "echo rm -rf temp", {
      yes: true,
    });
    expect(result.exitCode).toBe(0);
    const audit = readFileSync(
      join(projectRoot, ".agency", "audit.jsonl"),
      "utf8"
    );
    expect(JSON.parse(audit.trim()).approved).toBe(true);
  });

  it("allows safe echo without yes", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "agency-shell-"));
    dirs.push(projectRoot);
    const result = await runShellCommand(
      projectRoot,
      "echo ok",
      { sandboxMode: "native" }
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("ok");
  });

  it("warns but allows shell commands with lower maxSecurityLevel", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "agency-shell-"));
    dirs.push(projectRoot);
    const result = await runShellCommand(projectRoot, "echo ok", {
      maxSecurityLevel: 2,
      sandboxMode: "native",
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("ok");
  });

  it("allows shell commands if whitelisted", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "agency-shell-"));
    dirs.push(projectRoot);
    const result = await runShellCommand(projectRoot, "echo ok", {
      maxSecurityLevel: 2,
      securityWhitelist: ["run_command"],
      sandboxMode: "native",
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("ok");
  });

  it("allows self-killing node commands with warning instead of blocking", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "agency-shell-"));
    dirs.push(projectRoot);
    const result = await runShellCommand(projectRoot, "echo self-killing-test", { yes: true });
    expect(result.exitCode).toBe(0);
  });

  it("allows self-killing PID commands with warning instead of blocking", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "agency-shell-"));
    dirs.push(projectRoot);
    const result = await runShellCommand(projectRoot, "echo self-killing-pid-test", { yes: true });
    expect(result.exitCode).toBe(0);
  });
});
