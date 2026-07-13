import { describe, expect, it, beforeEach, afterEach } from "vitest";
import {
  buildSynthesisUserMessage,
  clearDelegationCycle,
  completeDelegationBatch,
  isSynthesisBlockedTool,
  markDelegationSynthesisComplete,
  needsDelegationSynthesis,
  startDelegationBatch,
} from "../chat/delegation-cycle.js";
import { buildParallelDispatchReport } from "../agents/dispatch-report.js";
import type { ParallelDispatchResult } from "../agents/orchestrator.js";

describe("delegation-cycle", () => {
  const sessionId = "sess-delegation";
  const prevForced = process.env.AGENCY_FORCED_DELEGATION_SYNTHESIS;

  beforeEach(() => {
    clearDelegationCycle(sessionId);
    process.env.AGENCY_FORCED_DELEGATION_SYNTHESIS = "1";
  });

  afterEach(() => {
    if (prevForced === undefined) delete process.env.AGENCY_FORCED_DELEGATION_SYNTHESIS;
    else process.env.AGENCY_FORCED_DELEGATION_SYNTHESIS = prevForced;
  });

  it("enters awaiting synthesis after batch completes when forced synthesis is on", () => {
    const fanout: ParallelDispatchResult = {
      success: true,
      results: [{
        agentId: "planner",
        dispatchId: "d-1",
        exitCode: 0,
        stdout: "done",
        stderr: "",
        isolatedEnv: {},
      }],
    };
    const report = buildParallelDispatchReport(fanout, { batchId: "batch-1" });

    startDelegationBatch(sessionId, "batch-1", "Test batch");
    completeDelegationBatch(sessionId, report);

    expect(needsDelegationSynthesis(sessionId)).toBe(true);
    const msg = buildSynthesisUserMessage(sessionId);
    expect(msg).toContain("PARALLEL DISPATCH REPORT");
    expect(msg).toContain("Synthesize");

    markDelegationSynthesisComplete(sessionId);
    expect(needsDelegationSynthesis(sessionId)).toBe(false);
  });

  it("blocks dispatch tools during synthesis", () => {
    expect(isSynthesisBlockedTool("dispatch_parallel")).toBe(true);
    expect(isSynthesisBlockedTool("read_file")).toBe(false);
  });
});
