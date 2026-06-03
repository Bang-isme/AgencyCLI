import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

const REPO_ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "../../../..");
const FIXTURE_SKILLS = join(REPO_ROOT, "tests", "fixtures", "mock-skills");

vi.mock("execa", () => ({
  execa: vi.fn(),
}));

vi.mock("../router/model-router.js", () => ({
  routeUserPrompt: vi.fn(),
}));

vi.mock("../skills-root.js", () => ({
  resolveSkillsRoot: vi.fn(() => FIXTURE_SKILLS),
}));

vi.mock("../agents/workspace-isolation.js", () => ({
  createIsolatedWorkspace: vi.fn((root, agentId) => ({ tempDir: `/fake/ws-${agentId}`, projectRoot: root })),
  detectWorkspaceChanges: vi.fn(() => ({ createdOrModified: [], deleted: [] })),
  mergeWorkspaceChanges: vi.fn(() => ({ success: true, mergedFiles: [], deletedFiles: [], conflicts: [] })),
  cleanIsolatedWorkspace: vi.fn(),
}));

import { execa } from "execa";
import { routeUserPrompt } from "../router/model-router.js";
import * as chatOrchestrator from "../chat/orchestrator.js";
import * as chatStream from "../chat/stream.js";
import { EventBus } from "../events/event-bus.js";
import type { ReplayEvent } from "@agency/contracts";
import { StagingEngine } from "@agency/workspace";
import {
  buildIsolatedEnv,
  dispatchAgent,
  dispatchAgentsParallel,
  isAgentId,
  MANIFEST_AGENTS,
} from "../agents/orchestrator.js";

const mockedExeca = vi.mocked(execa);
const mockedRoute = vi.mocked(routeUserPrompt);

const baseRoute = {
  intent: "plan",
  suggested_agent: "planner",
  workflow: "plan",
  skills: ["codex-plan-writer"],
  provider: "anthropic" as const,
  warnings: [] as string[],
};

afterEach(() => {
  vi.clearAllMocks();
  delete process.env.AGENCY_VERIFY_LOOP;
});

describe("isAgentId", () => {
  it("accepts manifest agent ids and custom agents from .agency/agents.json", () => {
    expect(isAgentId("frontend-specialist")).toBe(true);
    expect(isAgentId("unknown-agent")).toBe(false);

    const tempRoot = mkdtempSync(join(tmpdir(), "agency-custom-agents-"));
    const fs = require("node:fs");
    fs.mkdirSync(join(tempRoot, ".agency"), { recursive: true });
    fs.writeFileSync(
      join(tempRoot, ".agency", "agents.json"),
      JSON.stringify({
        agents: {
          "custom-specialist": {
            disciplines: ["my-discipline"],
            promptTemplate: "my-prompt.md",
          },
        },
      }),
      "utf8"
    );

    expect(isAgentId("custom-specialist", tempRoot)).toBe(true);
    expect(isAgentId("unknown-agent", tempRoot)).toBe(false);

    rmSync(tempRoot, { recursive: true, force: true });
  });
});

describe("buildIsolatedEnv", () => {
  it("sets agency env keys and only inherits PATH", () => {
    const prevPath = process.env.PATH;
    const prevSkills = process.env.AGENCY_SKILLS_ROOT;
    process.env.PATH = "/bin";
    process.env.AGENCY_SKILLS_ROOT = "/should-not-inherit";

    try {
      const env = buildIsolatedEnv({
        agentId: "debugger",
        task: "Find root cause",
        projectRoot: "/proj",
        contextFiles: ["src/a.ts", "src/b.ts"],
      });

      expect(env.PATH).toBe("/bin");
      expect(env.AGENCY_AGENT_ID).toBe("debugger");
      expect(env.AGENCY_TASK).toBe("Find root cause");
      expect(env.AGENCY_PROJECT_ROOT).toBe("/proj");
      expect(env.AGENCY_CONTEXT_FILES).toBe("src/a.ts,src/b.ts");
      expect(env.AGENCY_SKILLS_ROOT).toBeUndefined();
    } finally {
      if (prevPath === undefined) delete process.env.PATH;
      else process.env.PATH = prevPath;
      if (prevSkills === undefined) delete process.env.AGENCY_SKILLS_ROOT;
      else process.env.AGENCY_SKILLS_ROOT = prevSkills;
    }
  });
});

describe("dispatchAgent", () => {
  let projectRoot: string;

  afterEach(() => {
    if (projectRoot) rmSync(projectRoot, { recursive: true, force: true });
  });

  it("runs prompt_router in isolated subprocess and logs dispatch JSON", async () => {
    projectRoot = mkdtempSync(join(tmpdir(), "agency-agents-"));
    mockedRoute.mockResolvedValue(baseRoute);
    mockedExeca.mockResolvedValue({
      exitCode: 0,
      stdout: JSON.stringify({
        intent: "plan",
        suggested_agent: "planner",
        workflow: "plan",
        skills: [],
      }),
      stderr: "",
    } as Awaited<ReturnType<typeof execa>>);

    vi.spyOn(chatStream, "runChatTurnWithStream").mockResolvedValue({
      route: baseRoute,
      routeSummary: "intent: plan · workflow: plan",
      assistantText: "Drafted plan successfully.",
      suggestedCommands: ["pnpm build"],
      routeOnly: false,
      budget: "balanced" as any,
      contextFiles: [],
      routeFromCache: false,
    });

    const result = await dispatchAgent(
      {
        agentId: "planner",
        task: "Draft plan",
        projectRoot,
      },
      { skillsRoot: FIXTURE_SKILLS }
    );

    expect(result.exitCode).toBe(0);
    expect(result.payload?.coordinatorRoute.intent).toBe("plan");
    expect(mockedRoute).toHaveBeenCalled();
    expect(mockedExeca).toHaveBeenCalledWith(
      "python",
      expect.arrayContaining([
        expect.stringContaining("prompt_router.py"),
        "--prompt",
        "[planner] Draft plan",
      ]),
      expect.objectContaining({
        cwd: projectRoot,
        env: expect.objectContaining({ AGENCY_AGENT_ID: "planner" }),
      })
    );
    expect(result.isolatedEnv.AGENCY_SKILLS_ROOT).toBeUndefined();

    const logs = readdirSync(join(projectRoot, ".agency", "agents")).filter(
      (name) => name.startsWith("dispatch-") && name.endsWith(".json")
    );
    expect(logs.length).toBe(1);
    const log = JSON.parse(
      readFileSync(join(projectRoot, ".agency", "agents", logs[0]!), "utf8")
    );
    expect(log.request.agentId).toBe("planner");
    expect(log.result.payload.suggestedCommands.length).toBeGreaterThan(0);
  });

  it("returns non-zero exit code if compilation fails during file edit suggestion validation", async () => {
    projectRoot = mkdtempSync(join(tmpdir(), "agency-agents-"));
    mockedRoute.mockResolvedValue(baseRoute);
    
    vi.spyOn(StagingEngine.prototype, "verifyTransaction").mockResolvedValue({
      success: false,
      errors: ["tsc compile error: Type 'string' is not assignable to type 'number'."],
    });

    // Mock prompt router to succeed and compilation check to fail
    mockedExeca.mockImplementation(async (file: string, args: string[], options: any) => {
      if (file === "python") {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            intent: "plan",
            suggested_agent: "planner",
            workflow: "plan",
            skills: [],
          }),
          stderr: "",
        } as any;
      }
      if (file === "pnpm") {
        return {
          exitCode: 1,
          stdout: "",
          stderr: "tsc compile error: Type 'string' is not assignable to type 'number'.",
        } as any;
      }
      return { exitCode: 0, stdout: "", stderr: "" } as any;
    });

    // Mock runChatTurnWithStream to return a file suggestion
    vi.spyOn(chatStream, "runChatTurnWithStream").mockResolvedValue({
      route: baseRoute,
      routeSummary: "intent: plan · workflow: plan",
      assistantText: "Here is the fix:\n<<<<<<< SEARCH:test.ts\nconst x = 1;\n=======\nconst x = 'broken';\n>>>>>>> REPLACE",
      suggestedCommands: [],
      routeOnly: false,
      budget: "balanced" as any,
      contextFiles: [],
      routeFromCache: false,
    });

    // Create file to edit
    const { writeFileSync } = await import("node:fs");
    writeFileSync(join(projectRoot, "test.ts"), "const x = 1;\n", "utf8");

    const result = await dispatchAgent(
      {
        agentId: "planner",
        task: "Fix type in test.ts",
        projectRoot,
      },
      { skillsRoot: FIXTURE_SKILLS }
    );

    // Should return exitCode: 1 and indicate compile errors in stderr
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Workspace compile and validation checks failed");
  });

  it("re-runs the agent on verification failure and succeeds (verify loop)", async () => {
    projectRoot = mkdtempSync(join(tmpdir(), "agency-agents-"));
    process.env.AGENCY_VERIFY_LOOP = "true";
    mockedRoute.mockResolvedValue(baseRoute);
    mockedExeca.mockResolvedValue({
      exitCode: 0,
      stdout: JSON.stringify({ intent: "plan", suggested_agent: "planner", workflow: "plan", skills: [] }),
      stderr: "",
    } as any);

    // First turn: a bad edit; fix turn: a corrected edit (both SEARCH/REPLACE on test.ts).
    let turn = 0;
    vi.spyOn(chatStream, "runChatTurnWithStream").mockImplementation(async () => {
      turn++;
      const target = turn === 1 ? "2" : "3";
      return {
        route: baseRoute,
        routeSummary: "intent: plan · workflow: plan",
        assistantText: `fix:\n<<<<<<< SEARCH:test.ts\nconst x = 1;\n=======\nconst x = ${target};\n>>>>>>> REPLACE`,
        suggestedCommands: [],
        routeOnly: false,
        budget: "balanced" as any,
        contextFiles: [],
        routeFromCache: false,
      } as any;
    });

    // Verify fails the first round, passes after the self-correction.
    let verifyCalls = 0;
    vi.spyOn(StagingEngine.prototype, "verifyTransaction").mockImplementation(async () => {
      verifyCalls++;
      return verifyCalls === 1
        ? { success: false, errors: ["boom build error"] }
        : { success: true, errors: [] };
    });
    vi.spyOn(StagingEngine.prototype, "commitTransaction").mockResolvedValue(["test.ts"]);

    const { writeFileSync } = await import("node:fs");
    writeFileSync(join(projectRoot, "test.ts"), "const x = 1;\n", "utf8");

    const result = await dispatchAgent(
      { agentId: "planner", task: "Fix the value of x", projectRoot },
      { skillsRoot: FIXTURE_SKILLS }
    );

    expect(result.exitCode).toBe(0);
    expect(turn).toBe(2); // the agent was re-run once with the failure fed back
    expect(verifyCalls).toBe(2); // verified again after the fix
    expect(result.payload?.filesWritten).toContain("test.ts");
  });

  it("self-heals an XML tool-call edit when validation fails (verify loop, no SEARCH/REPLACE)", async () => {
    projectRoot = mkdtempSync(join(tmpdir(), "agency-agents-"));
    process.env.AGENCY_VERIFY_LOOP = "true";
    mockedRoute.mockResolvedValue(baseRoute);

    // python = prompt router; anything else = the build command. Build fails the
    // first time, passes after the self-correction round.
    let buildCalls = 0;
    mockedExeca.mockImplementation(async (file: string) => {
      if (file === "python") {
        return {
          exitCode: 0,
          stdout: JSON.stringify({ intent: "plan", suggested_agent: "planner", workflow: "plan", skills: [] }),
          stderr: "",
        } as any;
      }
      buildCalls++;
      return buildCalls === 1
        ? ({ exitCode: 1, stdout: "", stderr: "TS2304: cannot find name 'foo'" } as any)
        : ({ exitCode: 0, stdout: "", stderr: "" } as any);
    });

    // No SEARCH/REPLACE blocks → the XML tool-call path; files reported written.
    let turn = 0;
    vi.spyOn(chatStream, "runChatTurnWithStream").mockImplementation(async () => {
      turn++;
      return {
        route: baseRoute,
        routeSummary: "intent: plan · workflow: plan",
        assistantText: "I edited the files directly via tools.",
        suggestedCommands: [],
        routeOnly: false,
        budget: "balanced" as any,
        contextFiles: [],
        routeFromCache: false,
        filesWritten: ["app.ts"],
      } as any;
    });

    const result = await dispatchAgent(
      { agentId: "planner", task: "Implement the feature", projectRoot },
      { skillsRoot: FIXTURE_SKILLS }
    );

    expect(result.exitCode).toBe(0);
    expect(turn).toBe(2); // re-ran the agent once to self-heal
    expect(buildCalls).toBe(2); // build failed, then passed after the fix
    expect(result.payload?.filesWritten).toContain("app.ts");
  });

  it("covers all manifest agents", () => {
    expect(MANIFEST_AGENTS).toHaveLength(8);
    for (const id of MANIFEST_AGENTS) {
      expect(isAgentId(id)).toBe(true);
    }
  });

  it("throttles streaming progress and never re-publishes the full accumulated transcript (TUI freeze fix)", async () => {
    projectRoot = mkdtempSync(join(tmpdir(), "agency-agents-"));
    mockedRoute.mockResolvedValue(baseRoute);
    mockedExeca.mockResolvedValue({
      exitCode: 0,
      stdout: JSON.stringify({ intent: "plan", suggested_agent: "planner", workflow: "plan", skills: [] }),
      stderr: "",
    } as Awaited<ReturnType<typeof execa>>);

    // Simulate a long streamed response: 200 token deltas fired back-to-back.
    // The old code published one progress event PER token carrying the full
    // accumulated text — the source of the event-loop starvation / frozen
    // spinner. The fix throttles to ≥200ms with a constant-size payload.
    vi.spyOn(chatStream, "runChatTurnWithStream").mockImplementation(
      async (_input: any, handlers: any) => {
        for (let i = 0; i < 200; i++) handlers.onDelta("token ");
        return {
          route: baseRoute,
          routeSummary: "intent: plan · workflow: plan",
          assistantText: "token ".repeat(200),
          suggestedCommands: [],
          routeOnly: false,
          budget: "balanced" as any,
          contextFiles: [],
          routeFromCache: false,
        } as any;
      }
    );

    const bus = EventBus.getInstance();
    const streaming: ReplayEvent[] = [];
    const onProgress = (e: ReplayEvent) => {
      const p = JSON.parse(e.payload) as { phase?: string };
      if (p.phase === "Streaming response") streaming.push(e);
    };
    bus.subscribe("subagent:progress", onProgress);

    try {
      await dispatchAgent(
        { agentId: "planner", task: "Stream a long answer", projectRoot },
        { skillsRoot: FIXTURE_SKILLS }
      );
      for (let i = 0; i < 50 && streaming.length === 0; i++) {
        await new Promise((resolve) => setImmediate(resolve));
      }

      // 200 synchronous deltas inside one throttle window → a tiny, bounded
      // number of events (not 200), and never the unbounded buffer.
      expect(streaming.length).toBeGreaterThan(0);
      expect(streaming.length).toBeLessThanOrEqual(5);
      for (const e of streaming) {
        const p = JSON.parse(e.payload) as Record<string, unknown>;
        expect(p.text).toBeUndefined();
        expect(p.thought).toBeUndefined();
        expect(typeof p.chars).toBe("number");
        // Constant-size heartbeat — must never balloon with the transcript.
        expect(Buffer.byteLength(e.payload)).toBeLessThan(256);
      }
    } finally {
      bus.unsubscribe("subagent:progress", onProgress);
    }
  });

  it("attaches agent attribution metadata to subagent lifecycle events (roadmap §B)", async () => {
    projectRoot = mkdtempSync(join(tmpdir(), "agency-agents-"));
    mockedRoute.mockResolvedValue(baseRoute);
    mockedExeca.mockResolvedValue({
      exitCode: 0,
      stdout: JSON.stringify({ intent: "plan", suggested_agent: "planner", workflow: "plan", skills: [] }),
      stderr: "",
    } as Awaited<ReturnType<typeof execa>>);
    vi.spyOn(chatStream, "runChatTurnWithStream").mockResolvedValue({
      route: baseRoute,
      routeSummary: "intent: plan · workflow: plan",
      assistantText: "Done.",
      suggestedCommands: [],
      routeOnly: false,
      budget: "balanced" as any,
      contextFiles: [],
      routeFromCache: false,
      completionMetadata: { promptTokens: 1000, completionTokens: 500 },
    } as any);

    const bus = EventBus.getInstance();
    const started: ReplayEvent[] = [];
    const finished: ReplayEvent[] = [];
    const onStarted = (e: ReplayEvent) => started.push(e);
    const onFinished = (e: ReplayEvent) => finished.push(e);
    bus.subscribe("subagent:started", onStarted);
    bus.subscribe("subagent:finished", onFinished);

    try {
      await dispatchAgent(
        { agentId: "planner", task: "Draft a unique attribution plan", projectRoot },
        { skillsRoot: FIXTURE_SKILLS }
      );

      // Drain the cooperative event queue until both lifecycle events land.
      for (let i = 0; i < 50 && (started.length === 0 || finished.length === 0); i++) {
        await new Promise((resolve) => setImmediate(resolve));
      }

      expect(started.length).toBeGreaterThan(0);
      expect(started[0]!.agentId).toBe("planner");

      expect(finished.length).toBeGreaterThan(0);
      expect(finished[0]!.agentId).toBe("planner");
      // durationMs + costUsd are attribution-only metadata (never folded into
      // the dedup/replay hash), estimated from the turn's token usage.
      expect(typeof finished[0]!.durationMs).toBe("number");
      expect(finished[0]!.durationMs!).toBeGreaterThanOrEqual(0);
      expect(typeof finished[0]!.costUsd).toBe("number");
      expect(finished[0]!.costUsd!).toBeGreaterThan(0);
    } finally {
      bus.unsubscribe("subagent:started", onStarted);
      bus.unsubscribe("subagent:finished", onFinished);
    }
  });
});

describe("dispatchAgentsParallel", () => {
  it("runs parallel agents, queues them, and supports partial-success merging", async () => {
    const root = "/fake/project";
    mockedRoute.mockResolvedValue(baseRoute);

    mockedExeca.mockResolvedValue({
      exitCode: 0,
      stdout: JSON.stringify({
        intent: "plan",
        suggested_agent: "planner",
        workflow: "plan",
        skills: [],
      }),
      stderr: "",
    } as Awaited<ReturnType<typeof execa>>);

    vi.spyOn(chatStream, "runChatTurnWithStream").mockResolvedValue({
      route: baseRoute,
      routeSummary: "intent: plan · workflow: plan",
      assistantText: "Success response",
      suggestedCommands: [],
      routeOnly: false,
      budget: "balanced" as any,
      contextFiles: [],
      routeFromCache: false,
    });

    const res = await dispatchAgentsParallel(
      root,
      [
        { agentId: "planner", task: "Task A" },
        { agentId: "debugger", task: "Task B" },
      ],
      { skillsRoot: FIXTURE_SKILLS }
    );

    expect(res.success).toBe(true);
    expect(res.results.length).toBe(2);
    expect(res.results[0]?.exitCode).toBe(0);
    expect(res.results[1]?.exitCode).toBe(0);
  });

  it("a pre-flight throw in one agent does not discard the whole batch", async () => {
    const root = "/fake/project";
    mockedRoute.mockResolvedValue(baseRoute);

    mockedExeca.mockResolvedValue({
      exitCode: 0,
      stdout: JSON.stringify({
        intent: "plan",
        suggested_agent: "planner",
        workflow: "plan",
        skills: [],
      }),
      stderr: "",
    } as Awaited<ReturnType<typeof execa>>);

    vi.spyOn(chatStream, "runChatTurnWithStream").mockResolvedValue({
      route: baseRoute,
      routeSummary: "intent: plan · workflow: plan",
      assistantText: "Success response",
      suggestedCommands: [],
      routeOnly: false,
      budget: "balanced" as any,
      contextFiles: [],
      routeFromCache: false,
    });

    // Seed the delegation chain so the "planner" dispatch trips the cycle guard —
    // a pre-flight throw (`DelegationLimitError`) that fires BEFORE dispatchAgentImpl's
    // own try/catch. "debugger" is clean. Before the resilience fix this rejected the
    // whole Promise.all batch (results: [], the clean agent's work discarded).
    process.env.AGENCY_DELEGATION_CHAIN = "planner";
    try {
      const res = await dispatchAgentsParallel(
        root,
        [
          { agentId: "planner", task: "Task A" },
          { agentId: "debugger", task: "Task B" },
        ],
        { skillsRoot: FIXTURE_SKILLS }
      );

      expect(res.results.length).toBe(2);
      const planner = res.results.find((r) => r.agentId === "planner");
      const dbg = res.results.find((r) => r.agentId === "debugger");
      expect(planner?.exitCode).toBe(1);
      expect(planner?.stderr).toContain("Circular delegation");
      expect(dbg?.exitCode).toBe(0);
      // Reported as a partial failure — not an all-or-nothing batch crash.
      expect(res.success).toBe(false);
    } finally {
      delete process.env.AGENCY_DELEGATION_CHAIN;
    }
  });
});
