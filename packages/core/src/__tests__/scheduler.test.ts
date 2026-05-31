import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../workflow/compose.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../workflow/compose.js")>();
  return {
    ...actual,
    runWorkflow: vi.fn(),
  };
});

import { runWorkflow } from "../workflow/compose.js";
import {
  addSchedule,
  loadSchedules,
  parseCronNext,
  removeSchedule,
  runDueSchedules,
  saveSchedules,
} from "../scheduler/schedule.js";

const mockedRunWorkflow = vi.mocked(runWorkflow);

const tmpDirs: string[] = [];

function makeProjectRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "agency-sched-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  vi.clearAllMocks();
  for (const dir of tmpDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("parseCronNext", () => {
  it("parses every:5m", () => {
    const from = new Date("2026-05-20T10:00:00.000Z");
    const next = parseCronNext("every:5m", from);
    expect(next?.toISOString()).toBe("2026-05-20T10:05:00.000Z");
  });

  it("parses every:1h", () => {
    const from = new Date("2026-05-20T10:00:00.000Z");
    const next = parseCronNext("every:1h", from);
    expect(next?.toISOString()).toBe("2026-05-20T11:00:00.000Z");
  });

  it("parses daily:09:00 later the same day", () => {
    const from = new Date("2026-05-20T08:00:00");
    const next = parseCronNext("daily:09:00", from);
    expect(next?.getHours()).toBe(9);
    expect(next?.getMinutes()).toBe(0);
    expect(next!.getTime()).toBeGreaterThan(from.getTime());
  });

  it("parses daily:09:00 on the next day when past that time", () => {
    const from = new Date("2026-05-20T10:30:00");
    const next = parseCronNext("daily:09:00", from);
    expect(next?.getDate()).toBe(21);
    expect(next?.getHours()).toBe(9);
  });

  it("parses standard 5-field cron */5 * * * *", () => {
    const from = new Date("2026-05-20T10:03:00");
    const next = parseCronNext("*/5 * * * *", from);
    expect(next?.getMinutes()).toBe(5);
  });
});

describe("schedules store", () => {
  it("loadSchedules returns empty file when missing", () => {
    const root = makeProjectRoot();
    expect(loadSchedules(root)).toEqual({ version: 1, schedules: [] });
  });

  it("addSchedule and removeSchedule round-trip", () => {
    const root = makeProjectRoot();
    const entry = addSchedule(root, {
      workflow: "create",
      cron: "every:5m",
      projectRoot: root,
    });
    expect(entry.workflow).toBe("create");
    expect(entry.cron).toBe("every:5m");
    expect(entry.nextRun).toBeDefined();

    const loaded = loadSchedules(root);
    expect(loaded.schedules).toHaveLength(1);

    removeSchedule(root, entry.id);
    expect(loadSchedules(root).schedules).toHaveLength(0);
  });
});

describe("runDueSchedules", () => {
  it("runs due enabled schedules and updates lastRun/nextRun", async () => {
    const root = makeProjectRoot();
    const past = new Date(Date.now() - 60_000).toISOString();
    saveSchedules(root, {
      version: 1,
      schedules: [
        {
          id: "sched-test",
          workflow: "create",
          cron: "every:5m",
          projectRoot: root,
          enabled: true,
          requireApproval: false,
          nextRun: past,
        },
      ],
    });

    mockedRunWorkflow.mockResolvedValueOnce({ status: "ok", steps: [] });

    const results = await runDueSchedules(root, { yes: true });
    expect(results).toEqual([
      { id: "sched-test", workflow: "create", status: "ok" },
    ]);
    expect(mockedRunWorkflow).toHaveBeenCalledWith(
      expect.any(String),
      root,
      "create",
      expect.objectContaining({ yes: true })
    );

    const updated = loadSchedules(root).schedules[0]!;
    expect(updated.lastRun).toBeDefined();
    expect(updated.nextRun).toBeDefined();
    expect(new Date(updated.nextRun!).getTime()).toBeGreaterThan(
      new Date(updated.lastRun!).getTime()
    );
  });

  it("skips schedules that require approval without --yes", async () => {
    const root = makeProjectRoot();
    saveSchedules(root, {
      version: 1,
      schedules: [
        {
          id: "sched-approval",
          workflow: "handoff",
          cron: "every:1h",
          projectRoot: root,
          enabled: true,
          requireApproval: true,
          nextRun: new Date(Date.now() - 1000).toISOString(),
        },
      ],
    });

    const results = await runDueSchedules(root);
    expect(results[0]?.status).toBe("skipped");
    expect(mockedRunWorkflow).not.toHaveBeenCalled();
  });
});
