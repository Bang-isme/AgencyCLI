import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  abortCheckpoint,
  listCheckpoints,
  loadCheckpoint,
  saveCheckpoint,
} from "../task/checkpoint.js";
import { parsePlanTasks, runPlan } from "../task/runner.js";

const SAMPLE_PLAN = `# Agency plan

### Task 1: Monorepo root

- [ ] **Scaffold workspace**

### Task 2: Skills root detection

- [ ] **Detect SKILLS_ROOT**

### Task 3: Plugin tools registry

- [ ] **Load plugin-tools.json**
`;

/** Simulates crash after first task; cleared before resume. */
const crashAfterFirst = new Set<string>();

afterEach(() => {
  crashAfterFirst.clear();
});

function makeTempProject(): string {
  return mkdtempSync(join(tmpdir(), "agency-task-"));
}

describe("parsePlanTasks", () => {
  it("parses ### Task N: headers and captures each task's body (todo items) as details", () => {
    expect(parsePlanTasks(SAMPLE_PLAN)).toEqual([
      { id: 1, title: "Monorepo root", details: "- [ ] **Scaffold workspace**" },
      { id: 2, title: "Skills root detection", details: "- [ ] **Detect SKILLS_ROOT**" },
      { id: 3, title: "Plugin tools registry", details: "- [ ] **Load plugin-tools.json**" },
    ]);
  });

  it("captures a multi-item checklist + prose as the task's details (the work the executor dispatches)", () => {
    const plan = `### Task 1: Build the parser

Some context prose.
- [ ] Write the tokenizer
- [ ] Write the AST builder

### Task 2: Test it
- [ ] Add unit tests
`;
    const tasks = parsePlanTasks(plan);
    expect(tasks[0]!.details).toContain("Some context prose.");
    expect(tasks[0]!.details).toContain("- [ ] Write the tokenizer");
    expect(tasks[0]!.details).toContain("- [ ] Write the AST builder");
    // The body stops at the next task heading — it must not bleed into task 2.
    expect(tasks[0]!.details).not.toContain("Add unit tests");
    expect(tasks[1]!.details).toBe("- [ ] Add unit tests");
  });
});

describe("runPlan checkpoints", () => {
  let projectRoot: string;

  afterEach(() => {
    if (projectRoot) rmSync(projectRoot, { recursive: true, force: true });
  });

  it("persists checkpoint under .agency/tasks and completes all tasks", async () => {
    projectRoot = makeTempProject();
    const planPath = join(projectRoot, "plan.md");
    const { writeFileSync } = await import("node:fs");
    writeFileSync(planPath, SAMPLE_PLAN, "utf8");

    const executed: number[] = [];
    const cp = await runPlan(projectRoot, planPath, {
      gateEvery: 0,
      onTask: async (task) => {
        executed.push(task.id);
      },
    });

    expect(cp.status).toBe("done");
    expect(cp.completed).toEqual([1, 2, 3]);
    expect(executed).toEqual([1, 2, 3]);

    const onDisk = loadCheckpoint(projectRoot, cp.id);
    expect(onDisk?.status).toBe("done");
    expect(
      readFileSync(join(projectRoot, ".agency", "tasks", `${cp.id}.json`), "utf8")
    ).toContain('"status": "done"');
  });

  it("resumes from checkpoint after simulated crash", async () => {
    projectRoot = makeTempProject();
    const planPath = join(projectRoot, "plan.md");
    const { writeFileSync } = await import("node:fs");
    writeFileSync(planPath, SAMPLE_PLAN, "utf8");

    let runId = "";

    await expect(
      runPlan(projectRoot, planPath, {
        gateEvery: 0,
        onTask: async (task) => {
          runId = listCheckpoints(projectRoot)[0]?.id ?? runId;
          if (task.id === 2) {
            crashAfterFirst.add(runId);
            throw new Error("simulated crash");
          }
        },
      })
    ).rejects.toThrow("simulated crash");

    expect(crashAfterFirst.has(runId)).toBe(true);
    const mid = loadCheckpoint(projectRoot, runId);
    expect(mid?.completed).toEqual([1]);
    expect(mid?.currentTask).toBe(2);
    expect(mid?.status).toBe("running");

    crashAfterFirst.delete(runId);

    const executed: number[] = [];
    const resumed = await runPlan(projectRoot, planPath, {
      taskId: runId,
      gateEvery: 0,
      onTask: async (task) => {
        executed.push(task.id);
      },
    });

    expect(resumed.status).toBe("done");
    expect(resumed.completed).toEqual([1, 2, 3]);
    expect(executed).toEqual([2, 3]);
  });

  it("honors --from by starting at task N", async () => {
    projectRoot = makeTempProject();
    const planPath = join(projectRoot, "plan.md");
    const { writeFileSync } = await import("node:fs");
    writeFileSync(planPath, SAMPLE_PLAN, "utf8");

    const executed: number[] = [];
    const cp = await runPlan(projectRoot, planPath, {
      from: 2,
      gateEvery: 0,
      onTask: async (task) => {
        executed.push(task.id);
      },
    });

    expect(executed).toEqual([2, 3]);
    expect(cp.completed).toEqual([2, 3]);
    expect(cp.completed).not.toContain(1);
  });

  it("abortCheckpoint marks run as aborted", () => {
    projectRoot = makeTempProject();
    saveCheckpoint(projectRoot, {
      id: "run-abort-test",
      planPath: join(projectRoot, "plan.md"),
      currentTask: 2,
      completed: [1],
      status: "running",
      updatedAt: new Date().toISOString(),
    });

    expect(abortCheckpoint(projectRoot, "run-abort-test")).toBe(true);
    expect(loadCheckpoint(projectRoot, "run-abort-test")?.status).toBe("aborted");
  });

  it("persists and restores harness configuration settings", async () => {
    projectRoot = makeTempProject();
    const planPath = join(projectRoot, "plan.md");
    const { writeFileSync } = await import("node:fs");
    writeFileSync(planPath, SAMPLE_PLAN, "utf8");

    const cp = await runPlan(projectRoot, planPath, {
      harness: true,
      maxAttempts: 5,
      gateEvery: 2,
      onTask: async () => {},
    });

    const onDisk = loadCheckpoint(projectRoot, cp.id);
    expect(onDisk?.harness).toBe(true);
    expect(onDisk?.maxAttempts).toBe(5);
    expect(onDisk?.gateEvery).toBe(2);

    // Save a custom checkpoint to resume without overrides
    saveCheckpoint(projectRoot, {
      id: "resume-harness-test",
      planPath,
      currentTask: 2,
      completed: [1],
      status: "paused",
      updatedAt: new Date().toISOString(),
      harness: true,
      maxAttempts: 4,
      gateEvery: 1,
    });

    // Save another custom checkpoint to resume with overrides
    saveCheckpoint(projectRoot, {
      id: "resume-override-test",
      planPath,
      currentTask: 2,
      completed: [1],
      status: "paused",
      updatedAt: new Date().toISOString(),
      harness: true,
      maxAttempts: 4,
      gateEvery: 1,
    });

    // Resume without overrides (restores from checkpoint)
    const resumed = await runPlan(projectRoot, "", {
      taskId: "resume-harness-test",
      onTask: async () => {},
    });
    expect(resumed.harness).toBe(true);
    expect(resumed.maxAttempts).toBe(4);
    expect(resumed.gateEvery).toBe(1);

    // Resume with overrides
    const resumedWithOverrides = await runPlan(projectRoot, "", {
      taskId: "resume-override-test",
      harness: false,
      maxAttempts: 9,
      gateEvery: 4,
      onTask: async () => {},
    });
    expect(resumedWithOverrides.harness).toBe(false);
    expect(resumedWithOverrides.maxAttempts).toBe(9);
    expect(resumedWithOverrides.gateEvery).toBe(4);
  });
});
