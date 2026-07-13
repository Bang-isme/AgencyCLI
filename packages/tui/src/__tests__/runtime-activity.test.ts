import { describe, expect, it } from "vitest";
import {
  latestActiveActivity,
  phaseFromActivities,
  reduceToolFinished,
  reduceToolStarted,
} from "../state/runtime-activity.js";

describe("runtime activity reducer", () => {
  it("filters update_plan from display activities", () => {
    const started = reduceToolStarted([], {
      name: "update_plan",
      action: "other",
      target: "",
      turnId: "t",
      seq: 1,
    });
    expect(started).toEqual([]);

    const finished = reduceToolFinished(started, {
      name: "update_plan",
      action: "other",
      target: "",
      turnId: "t",
      seq: 2,
      summary: "1.2 KB",
    }, true);
    expect(finished).toEqual([]);
  });

  it("derives phase from the latest active tool", () => {
    const activities = reduceToolStarted([], {
      name: "execute_command",
      action: "exec",
      target: "npm run build",
      turnId: "t",
      seq: 1,
    });

    expect(latestActiveActivity(activities)?.name).toBe("execute_command");
    expect(phaseFromActivities(activities)).toBe("running");
  });

  it("returns idle after the active tool completes", () => {
    const started = reduceToolStarted([], {
      name: "write_file",
      action: "write",
      target: "src/App.tsx",
      turnId: "t",
      seq: 1,
    });
    const finished = reduceToolFinished(started, {
      name: "write_file",
      action: "write",
      target: "src/App.tsx",
      turnId: "t",
      seq: 2,
    }, true);

    expect(latestActiveActivity(finished)).toBeUndefined();
    expect(phaseFromActivities(finished)).toBe("idle");
  });
});
