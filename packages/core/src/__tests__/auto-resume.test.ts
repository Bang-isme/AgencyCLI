import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { autoResumeRecoverableTasks } from "../runtime/bootstrap.js";
import { saveCheckpoint, type TaskCheckpoint } from "../task/checkpoint.js";
import { EventBus } from "../events/event-bus.js";

function makeCheckpoint(id: string, status: TaskCheckpoint["status"]): TaskCheckpoint {
  return {
    id,
    planPath: "plan.md",
    currentTask: 1,
    completed: [0],
    status,
    updatedAt: new Date().toISOString(),
  };
}

describe("autoResumeRecoverableTasks", () => {
  let projectRoot = "";

  afterEach(() => {
    delete process.env.AGENCY_AUTO_RECOVER;
    delete process.env.AGENCY_MAX_CRASH_LOOPS;
    EventBus.getInstance().clear();
    if (projectRoot) {
      rmSync(projectRoot, { recursive: true, force: true });
      projectRoot = "";
    }
  });

  it("is a no-op (no resume) when autoRecover is off", async () => {
    projectRoot = mkdtempSync(join(tmpdir(), "agency-resume-"));
    process.env.AGENCY_AUTO_RECOVER = "false";
    saveCheckpoint(projectRoot, makeCheckpoint("t1", "running"));

    let called = 0;
    const outcomes = await autoResumeRecoverableTasks(projectRoot, {
      runPlan: async () => {
        called++;
        return makeCheckpoint("t1", "done");
      },
    });

    expect(outcomes).toEqual([]);
    expect(called).toBe(0);
  });

  it("resumes a crashed (running) task and clears the counter on completion", async () => {
    projectRoot = mkdtempSync(join(tmpdir(), "agency-resume-"));
    process.env.AGENCY_AUTO_RECOVER = "true";
    saveCheckpoint(projectRoot, makeCheckpoint("t1", "running"));

    const seen: string[] = [];
    const outcomes = await autoResumeRecoverableTasks(projectRoot, {
      runPlan: async (_root, _plan, o) => {
        seen.push(o.taskId);
        return makeCheckpoint("t1", "done");
      },
    });

    expect(seen).toEqual(["t1"]);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toMatchObject({ taskId: "t1", resumed: true, status: "done", abandoned: false });
    // Counter cleared after a completed resume.
    expect(existsSync(join(projectRoot, ".agency", "resume", "t1.json"))).toBe(false);
  });

  it("does not auto-resume an intentionally paused task", async () => {
    projectRoot = mkdtempSync(join(tmpdir(), "agency-resume-"));
    process.env.AGENCY_AUTO_RECOVER = "true";
    saveCheckpoint(projectRoot, makeCheckpoint("t1", "paused"));

    let called = 0;
    const outcomes = await autoResumeRecoverableTasks(projectRoot, {
      runPlan: async () => {
        called++;
        return makeCheckpoint("t1", "done");
      },
    });

    expect(outcomes).toEqual([]);
    expect(called).toBe(0);
  });

  it("abandons a task that keeps crashing on resume (crash-loop guard)", async () => {
    projectRoot = mkdtempSync(join(tmpdir(), "agency-resume-"));
    process.env.AGENCY_AUTO_RECOVER = "true";
    saveCheckpoint(projectRoot, makeCheckpoint("t1", "running"));

    const crashing = {
      maxCrashLoops: 2,
      runPlan: async (): Promise<TaskCheckpoint> => {
        throw new Error("boom-on-resume");
      },
    };

    const a1 = await autoResumeRecoverableTasks(projectRoot, crashing);
    expect(a1[0]).toMatchObject({ resumed: true, abandoned: false, attempts: 1 });
    expect(a1[0]!.error).toContain("boom-on-resume");

    const a2 = await autoResumeRecoverableTasks(projectRoot, crashing);
    expect(a2[0]).toMatchObject({ resumed: true, abandoned: false, attempts: 2 });

    // Ceiling reached → abandoned, runPlan NOT invoked again.
    let calledAfterCeiling = 0;
    const a3 = await autoResumeRecoverableTasks(projectRoot, {
      maxCrashLoops: 2,
      runPlan: async (): Promise<TaskCheckpoint> => {
        calledAfterCeiling++;
        throw new Error("should-not-run");
      },
    });
    expect(a3[0]).toMatchObject({ resumed: false, abandoned: true, attempts: 2 });
    expect(calledAfterCeiling).toBe(0);
  });
});
