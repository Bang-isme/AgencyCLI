import { describe, expect, it } from "vitest";
import { activityPhaseFromThought, getPhaseLabel } from "../state/context-tracker.js";
import { computeExecutionPhaseStatuses } from "../components/ExecutionPanel.js";

describe("§8.10-B activityPhaseFromThought", () => {
  it("maps the core tool-narration sources to the matching activity phase", () => {
    // describeToolActivity (core) emits these source/phase pairs for main-turn tools.
    expect(activityPhaseFromThought("retrieval", "retrieval")).toBe("reading"); // read/search
    expect(activityPhaseFromThought("worker", "editing")).toBe("editing");      // write/edit
    expect(activityPhaseFromThought("sandbox", "editing")).toBe("running");     // execute_command
    expect(activityPhaseFromThought("worker", "planning")).toBe("thinking");    // dispatch_subagent
  });

  it("maps the other narration sources (planner/validator) sensibly", () => {
    expect(activityPhaseFromThought("planner", "planning")).toBe("routing");
    expect(activityPhaseFromThought("scheduler", "planning")).toBe("routing");
    expect(activityPhaseFromThought("validator", "validation")).toBe("analyzing");
  });

  it("returns null for sources with no activity signal (phase left unchanged)", () => {
    expect(activityPhaseFromThought("governance", "validation")).toBeNull();
    expect(activityPhaseFromThought("risk-engine", "validation")).toBeNull();
    expect(activityPhaseFromThought(undefined, undefined)).toBeNull();
  });

  it("every mapped phase has a human label (incl. the new 'running')", () => {
    expect(getPhaseLabel("running")).toBe("Running");
    expect(getPhaseLabel("reading")).toBe("Reading");
    expect(getPhaseLabel("editing")).toBe("Editing");
  });
});

describe("§8.10-B computeExecutionPhaseStatuses", () => {
  it("retrieval/planning phases activate PLAN", () => {
    for (const p of ["routing", "reading", "exploring", "thinking"]) {
      const s = computeExecutionPhaseStatuses(p);
      expect(s.plan).toBe("active");
      expect(s.execute).toBe("pending");
    }
  });

  it("editing/running/writing phases mark PLAN done + EXECUTE active", () => {
    for (const p of ["writing", "editing", "running"]) {
      const s = computeExecutionPhaseStatuses(p);
      expect(s.plan).toBe("done");
      expect(s.execute).toBe("active");
      expect(s.verify).toBe("pending");
    }
  });

  it("analyzing/validating phases mark VERIFY active (plan+execute done)", () => {
    for (const p of ["validating", "analyzing"]) {
      const s = computeExecutionPhaseStatuses(p);
      expect(s.plan).toBe("done");
      expect(s.execute).toBe("done");
      expect(s.verify).toBe("active");
    }
  });

  it("recovering reveals + activates the RECOVER node", () => {
    const s = computeExecutionPhaseStatuses("recovering");
    expect(s.recover).toBe("active");
    expect(computeExecutionPhaseStatuses("reading").recover).toBe("hidden");
  });

  it("idle marks everything done (incl. COMPLETE)", () => {
    const s = computeExecutionPhaseStatuses("idle");
    expect(s.plan).toBe("done");
    expect(s.execute).toBe("done");
    expect(s.verify).toBe("done");
    expect(s.complete).toBe("done");
  });

  it("an unknown phase leaves all nodes pending (no false 'active')", () => {
    const s = computeExecutionPhaseStatuses("banana");
    expect(s.plan).toBe("pending");
    expect(s.execute).toBe("pending");
    expect(s.verify).toBe("pending");
    expect(s.recover).toBe("hidden");
    expect(s.complete).toBe("pending");
  });
});
