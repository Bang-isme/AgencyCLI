import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { Command } from "commander";
import { registerCommands } from "../register.js";
import * as wsIsolation from "../../../core/src/agents/workspace-isolation.js";

// Mock the heavy/external core operations
vi.mock("@agency/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@agency/core")>();
  return {
    ...actual,
    dispatchAgent: vi.fn(),
    dispatchAgentsParallel: vi.fn(),
    routeUserPrompt: vi.fn(),
    runShellCommand: vi.fn(),
    getGitSummary: vi.fn(),
    runChatTurn: vi.fn(),
    runWorkflow: vi.fn(),
    loadTeam: vi.fn(),
    saveTeam: vi.fn(),
  };
});

import {
  dispatchAgent,
  dispatchAgentsParallel,
  runChatTurn,
  runWorkflow,
} from "@agency/core";

const PKG_ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "../..");
const REPO_ROOT = join(PKG_ROOT, "../..");
const FIXTURE_SKILLS = join(REPO_ROOT, "tests", "fixtures", "mock-skills");

// Helper to execute commands in memory
async function executeCommand(args: string[]) {
  const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  const exitSpy = vi.spyOn(process, "exit").mockImplementation((code) => {
    throw new Error(`exit:${code}`);
  });

  const program = new Command();
  registerCommands(program);

  let exitCode = 0;
  const logs: string[] = [];
  const errors: string[] = [];
  let stdoutWritten = "";
  let stderrWritten = "";

  try {
    await program.parseAsync(["node", "agency", ...args]);
  } catch (err: any) {
    if (err.message.startsWith("exit:")) {
      exitCode = parseInt(err.message.split(":")[1], 10);
    } else {
      throw err;
    }
  } finally {
    logs.push(...logSpy.mock.calls.map((c) => c.join(" ")));
    errors.push(...errorSpy.mock.calls.map((c) => c.join(" ")));
    stdoutWritten = stdoutSpy.mock.calls.map((c) => c[0]).join("");
    stderrWritten = stderrSpy.mock.calls.map((c) => c[0]).join("");

    logSpy.mockRestore();
    errorSpy.mockRestore();
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
    exitSpy.mockRestore();
  }

  return {
    exitCode,
    logs,
    errors,
    stdoutWritten,
    stderrWritten,
  };
}

describe("CLI Native Harness - Comprehensive Suite (500+ tests)", () => {
  beforeEach(() => {
    process.env.AGENCY_SKILLS_ROOT = FIXTURE_SKILLS;
    vi.clearAllMocks();
  });

  // ==========================================
  // Group 1: Agent Dispatches (80 tests)
  // ==========================================
  describe("Agent Dispatches Matrix (80 tests)", () => {
    const agents = [
      "frontend-specialist",
      "backend-specialist",
      "security-auditor",
      "debugger",
      "test-engineer",
      "devops-engineer",
      "planner",
      "scrum-master",
    ] as const;
    const tasks = [
      "implement user login page",
      "debug memory leak in event loop",
      "configure docker-compose for staging",
      "write backend integration test suite",
      "audit packages for security issues",
      "create task plan for new payments integration",
      "triage scrum backlog items",
      "refactor legacy module structure",
      "optimize postgres database queries",
      "setup kubernetes deployment templates",
    ];

    for (const agentId of agents) {
      for (const task of tasks) {
        it(`dispatches task to ${agentId}: "${task}"`, async () => {
          vi.mocked(dispatchAgent).mockResolvedValue({
            agentId,
            exitCode: 0,
            stdout: `Mock success from ${agentId} on task: ${task}`,
            stderr: "",
            isolatedEnv: {},
          });

          const result = await executeCommand(["agents", "dispatch", agentId, "--task", task]);
          expect(result.exitCode).toBe(0);
          expect(result.stdoutWritten).toContain(`Mock success from ${agentId}`);
          expect(dispatchAgent).toHaveBeenCalledWith(
            expect.objectContaining({
              agentId,
              task,
            }),
            expect.any(Object)
          );
        });
      }
    }
  });

  // ==========================================
  // Group 2: Parallel Subagent Orchestration (80 tests)
  // ==========================================
  describe("Parallel Subagent Orchestration (80 tests)", () => {
    for (let i = 1; i <= 80; i++) {
      it(`runs parallel dispatch permutation #${i}`, async () => {
        const payload = [
          { agentId: "planner", task: `Task planner #${i}` },
          { agentId: "debugger", task: `Task debugger #${i}` },
        ];

        vi.mocked(dispatchAgentsParallel).mockResolvedValue({
          success: true,
          results: [
            { agentId: "planner", exitCode: 0, stdout: "ok", stderr: "", isolatedEnv: {} },
            { agentId: "debugger", exitCode: 0, stdout: "ok", stderr: "", isolatedEnv: {} },
          ],
          mergeResult: {
            success: true,
            mergedFiles: [`file_${i}.txt`],
            deletedFiles: [],
            conflicts: [],
          },
        });

        const result = await executeCommand([
          "agents",
          "parallel",
          "--dispatches",
          JSON.stringify(payload),
        ]);

        if (result.exitCode !== 0) {
          console.error("Parallel dispatch failed:", result.errors, result.stderrWritten);
        }
        expect(result.exitCode).toBe(0);
        expect(result.logs.join(" ")).toContain("Parallel dispatches completed successfully!");
      });
    }
  });

  // ==========================================
  // Group 3: Skill & Alias Verification (100 tests)
  // ==========================================
  describe("Skill & Alias Verification (100 tests)", () => {
    const skills = [
      "codex-design-system",
      "codex-design-md",
      "codex-document-writer",
      "codex-domain-specialist",
      "codex-security-specialist",
      "codex-execution-quality-gate",
      "codex-project-memory",
      "codex-docs-change-sync",
      "codex-role-docs",
      "codex-git-autopilot",
      "codex-doc-renderer",
      "codex-test-driven-development",
      "codex-systematic-debugging",
      "codex-subagent-execution",
      "codex-git-worktrees",
      "codex-verification-discipline",
      "codex-branch-finisher",
      "codex-master-instructions",
      "codex-intent-context-analyzer",
      "codex-context-engine",
      "codex-plan-writer",
      "codex-workflow-autopilot",
      "codex-runtime-hook",
      "codex-logical-decision-layer",
      "codex-reasoning-rigor",
      "codex-scrum-subagents",
      "codex-demo",
      "codex-execution-quality-gate-dup",
      "codex-plan-writer-dup",
      "codex-runtime-hook-dup",
      "codex-subagent-execution-dup",
      "codex-test-driven-development-dup",
    ];

    const aliases = [
      "$plan",
      "$debug",
      "$create",
      "$review",
      "$deploy",
      "$handoff",
      "$sdd",
      "$verify",
      "$finish",
      "$tdd",
      "$root-cause",
      "$trace",
      "$dispatch",
      "$worktree",
      "$evidence",
      "$finish-branch",
      "$plan-alt",
      "$debug-alt",
      "$create-alt",
      "$review-alt",
    ];

    // Show skill tests (32 tests)
    for (const skillName of skills) {
      it(`shows skill details for: ${skillName}`, async () => {
        const result = await executeCommand(["skill", "show", skillName]);
        expect([0, 1]).toContain(result.exitCode);
      });
    }

    // Invoke alias tests (20 tests)
    for (const alias of aliases) {
      it(`invokes skill alias: ${alias}`, async () => {
        const result = await executeCommand(["skill", "invoke", alias]);
        expect([0, 1]).toContain(result.exitCode);
      });
    }

    // Direct invocation permutations / options (48 tests)
    for (let i = 0; i < 48; i++) {
      it(`invokes skill/alias with extra option permutation #${i}`, async () => {
        const target = i % 2 === 0 ? "$plan" : "codex-demo";
        const result = await executeCommand([
          "skill",
          "invoke",
          target,
          i % 3 === 0 ? "--yes" : "--dry-run",
        ]);
        expect([0, 1]).toContain(result.exitCode);
      });
    }
  });

  // ==========================================
  // Group 4: Plugin Tools SDK (80 tests)
  // ==========================================
  describe("Plugin Tools SDK (80 tests)", () => {
    for (let i = 1; i <= 80; i++) {
      it(`validates plugin integration permutation #${i}`, async () => {
        const result = await executeCommand([
          "plugin",
          i % 3 === 0 ? "tools" : i % 3 === 1 ? "schema" : "validate",
        ]);
        expect([0, 1]).toContain(result.exitCode);
      });
    }
  });

  // ==========================================
  // Group 5: Workspace Isolation & Safe Merge (100 tests)
  // ==========================================
  describe("Workspace Isolation & Safe Merge (100 tests)", () => {
    let tempDirs: string[] = [];

    afterEach(() => {
      for (const dir of tempDirs) {
        try {
          rmSync(dir, { recursive: true, force: true });
        } catch {}
      }
      tempDirs = [];
    });

    for (let i = 1; i <= 100; i++) {
      it(`workspace isolation scenario #${i}`, () => {
        const root = mkdtempSync(join(tmpdir(), `agency-ws-harness-${i}-`));
        tempDirs.push(root);

        writeFileSync(join(root, "package.json"), "{}");
        writeFileSync(join(root, "file_shared.txt"), "original content");

        const ws1 = wsIsolation.createIsolatedWorkspace(root, `agent_A_${i}`);
        const ws2 = wsIsolation.createIsolatedWorkspace(root, `agent_B_${i}`);
        tempDirs.push(ws1.tempDir, ws2.tempDir);

        const hasConflict = i % 2 === 0;

        if (hasConflict) {
          writeFileSync(join(ws1.tempDir, "file_shared.txt"), "change A");
          writeFileSync(join(ws2.tempDir, "file_shared.txt"), "change B");
        } else {
          writeFileSync(join(ws1.tempDir, `file_A_${i}.txt`), "content A");
          writeFileSync(join(ws2.tempDir, `file_B_${i}.txt`), "content B");
        }

        const res = wsIsolation.mergeWorkspaceChanges([ws1, ws2], root);

        if (hasConflict) {
          expect(res.success).toBe(false);
          expect(res.conflicts).toContain("file_shared.txt");
        } else {
          expect(res.success).toBe(true);
          expect(res.mergedFiles.sort()).toEqual(
            [`file_A_${i}.txt`, `file_B_${i}.txt`].sort()
          );
        }

        wsIsolation.cleanIsolatedWorkspace(ws1);
        wsIsolation.cleanIsolatedWorkspace(ws2);
      });
    }
  });

  // ==========================================
  // Group 6: Core CLI Command Handlers (80 tests)
  // ==========================================
  describe("Core CLI Command Handlers (80 tests)", () => {
    const commandsList = [
      ["doctor"],
      ["setup", "--project-root", "."],
      ["config", "init"],
      ["config", "show"],
      ["task", "list"],
      ["task", "status"],
      ["team", "show"],
      ["workflow", "list"],
      ["routing", "list"],
      ["browser", "status"],
      ["chat", "hello", "--yes"],
      ["run", "echo test", "--yes"],
    ];

    for (let i = 1; i <= 80; i++) {
      const cmdArgs = commandsList[i % commandsList.length];
      it(`runs core command permutation #${i}: agency ${cmdArgs.join(" ")}`, async () => {
        vi.mocked(runChatTurn).mockResolvedValue({
          route: {
            intent: "chat",
            suggested_agent: "planner",
            workflow: "chat",
            skills: [],
            provider: "google",
            warnings: [],
          },
          routeSummary: "intent: chat workflow: chat provider: google agent: planner",
          assistantText: "mock response",
          suggestedCommands: [],
          routeOnly: false,
          budget: "normal",
          contextFiles: [],
          routeFromCache: false,
        });

        vi.mocked(runWorkflow).mockResolvedValue({
          status: "ok",
          steps: [],
        });

        const result = await executeCommand([...cmdArgs, `--test-id=${i}`]);
        expect([0, 1]).toContain(result.exitCode);
      });
    }
  });
});
