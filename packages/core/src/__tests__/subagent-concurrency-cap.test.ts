import { mkdtempSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeAllDbs } from "@agency/memory";

const REPO_ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "../../../..");
const FIXTURE_SKILLS = join(REPO_ROOT, "tests", "fixtures", "mock-skills");

vi.mock("execa", () => ({ execa: vi.fn() }));
vi.mock("../router/model-router.js", () => ({ routeUserPrompt: vi.fn() }));

import { execa } from "execa";
import { routeUserPrompt } from "../router/model-router.js";
import { dispatchAgent } from "../agents/orchestrator.js";

const mockedExeca = vi.mocked(execa);
const mockedRoute = vi.mocked(routeUserPrompt);

const baseRoute = {
  intent: "plan",
  suggested_agent: "planner",
  workflow: "plan",
  skills: [],
  provider: "anthropic" as const,
  warnings: [],
};

/**
 * Slice C — the chat turn loop Promise.all's its tool calls, so several
 * dispatch_subagent calls spawn full subagents concurrently. The delegation
 * guards bound recursion depth/cycles, NOT fan-out breadth, so the runtime path
 * was uncapped. `subagentConcurrencyCap` adds a shared semaphore that limits
 * in-flight dispatchAgent calls to maxParallelAgents. These tests gate the first
 * await inside a dispatch (routeUserPrompt) so we can observe exactly how many
 * dispatches are admitted concurrently — deterministically, no timing sleeps.
 */
describe("subagent fan-out concurrency cap", () => {
  let projectRoot: string;
  const prev = process.env.AGENCY_SUBAGENT_CONCURRENCY_CAP;

  beforeEach(() => {
    vi.clearAllMocks();
    projectRoot = mkdtempSync(join(tmpdir(), "agency-cap-"));
    writeFileSync(join(projectRoot, "package.json"), '{"name":"t"}');
    // Subagent execution + router spawn go through execa (mocked): succeed quietly.
    mockedExeca.mockResolvedValue({
      exitCode: 0,
      stdout: JSON.stringify({ suggested_agent: "planner" }),
      stderr: "",
    } as Awaited<ReturnType<typeof execa>>);
  });

  afterEach(() => {
    closeAllDbs();
    if (existsSync(projectRoot)) rmSync(projectRoot, { recursive: true, force: true });
    if (prev === undefined) delete process.env.AGENCY_SUBAGENT_CONCURRENCY_CAP;
    else process.env.AGENCY_SUBAGENT_CONCURRENCY_CAP = prev;
  });

  /** A routeUserPrompt mock that blocks on a shared gate; counts entries. */
  function gatedRoute() {
    let entries = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    mockedRoute.mockImplementation(async () => {
      entries++;
      await gate;
      return baseRoute;
    });
    return { count: () => entries, release: () => release() };
  }

  it("flag ON: admits at most maxParallelAgents dispatches concurrently", async () => {
    process.env.AGENCY_SUBAGENT_CONCURRENCY_CAP = "1";
    const g = gatedRoute();

    const runs = [0, 1, 2, 3].map(() =>
      dispatchAgent(
        { agentId: "planner", task: "t", projectRoot },
        { skillsRoot: FIXTURE_SKILLS, maxParallelAgents: 2 }
      )
    );

    // Exactly 2 reach the (gated) router; calls 3+4 wait at the semaphore.
    // Generous timeout: under a loaded machine the pre-route async steps
    // (event publish, capability registry) can lag — but the cap value is exact.
    await vi.waitFor(() => expect(g.count()).toBe(2), { timeout: 5000, interval: 10 });
    expect(g.count()).toBe(2); // held — no third admitted while the gate is closed

    g.release();
    const results = await Promise.all(runs);
    expect(results).toHaveLength(4); // all four completed (queue drained, no deadlock)
    expect(g.count()).toBeGreaterThan(2); // the queued dispatches were admitted once slots freed
  });

  it("flag OFF (legacy): all dispatches run concurrently (uncapped Promise.all)", async () => {
    delete process.env.AGENCY_SUBAGENT_CONCURRENCY_CAP;
    const g = gatedRoute();

    const runs = [0, 1, 2, 3].map(() =>
      dispatchAgent(
        { agentId: "planner", task: "t", projectRoot },
        { skillsRoot: FIXTURE_SKILLS, maxParallelAgents: 2 }
      )
    );

    // No cap → all four enter the router at once even though maxParallelAgents=2.
    await vi.waitFor(() => expect(g.count()).toBe(4), { timeout: 5000, interval: 10 });

    g.release();
    await Promise.all(runs);
  });
});
