import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { SessionTraceRecorder, createTraceRecorder } from "../chat/trace-recorder.js";

describe("SessionTraceRecorder (§2.5 record side)", () => {
  const dirs: string[] = [];
  const prevEnv = process.env.AGENCY_TRACE_RECORD;

  afterEach(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    dirs.length = 0;
    if (prevEnv === undefined) delete process.env.AGENCY_TRACE_RECORD;
    else process.env.AGENCY_TRACE_RECORD = prevEnv;
  });

  it("records turns + tool calls and persists a DeterministicExecutionTrace", () => {
    const root = mkdtempSync(join(tmpdir(), "agency-trace-"));
    dirs.push(root);

    const rec = new SessionTraceRecorder(root, "sess-1", "fix the bug");
    rec.recordLlmResponse("<read_file><path>a.ts</path></read_file>", "tool_calls");
    rec.recordTool("read_file", { path: "a.ts" }, "contents");
    rec.recordTool("write_file", { path: "a.ts", content: "x" }, "Success");
    rec.recordLlmResponse("Fixed.", "stop");
    rec.recordTurn(123);
    rec.save();

    const file = join(root, ".agency", "traces", "sess-1.json");
    expect(existsSync(file)).toBe(true);
    const trace = JSON.parse(readFileSync(file, "utf8"));
    expect(trace.sessionId).toBe("sess-1");
    expect(trace.goal).toBe("fix the bug");
    expect(trace.timings).toEqual([123]);
    expect(trace.toolOutputs).toHaveLength(2);
    expect(trace.toolOutputs[0]).toMatchObject({
      toolName: "read_file",
      arguments: { path: "a.ts" },
      output: "contents",
    });
    expect(trace.toolOutputs[1]).toMatchObject({ toolName: "write_file" });
    // §2.5 — the model's completions are persisted alongside the tool I/O.
    expect(trace.llmResponses).toHaveLength(2);
    expect(trace.llmResponses[0]).toMatchObject({ text: "<read_file><path>a.ts</path></read_file>", finishReason: "tool_calls" });
    expect(trace.llmResponses[1]).toMatchObject({ text: "Fixed.", finishReason: "stop" });
  });

  it("createTraceRecorder returns null unless AGENCY_TRACE_RECORD is set", () => {
    delete process.env.AGENCY_TRACE_RECORD;
    expect(createTraceRecorder("/tmp", "s", "g")).toBeNull();

    process.env.AGENCY_TRACE_RECORD = "1";
    expect(createTraceRecorder("/tmp", "s", "g")).toBeInstanceOf(SessionTraceRecorder);
  });

  it("save() is best-effort and never throws (unwritable root)", () => {
    const base = mkdtempSync(join(tmpdir(), "agency-trace-"));
    dirs.push(base);
    const asFile = join(base, "iam-a-file");
    writeFileSync(asFile, "x", "utf8");
    // projectRoot is a file → mkdir(`<file>/.agency/traces`) fails → swallowed.
    const rec = new SessionTraceRecorder(asFile, "s", "g");
    rec.recordTurn(1);
    expect(() => rec.save()).not.toThrow();
    expect(dirname(asFile)).toBe(base);
  });
});
