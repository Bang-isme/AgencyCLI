import { describe, expect, it } from "vitest";
import { parseSystemActivityLine } from "../components/conversation/TraceTelemetry.js";

describe("§8.10-E parseSystemActivityLine (single canonical classification)", () => {
  it("classifies 'Spawning specialist' and extracts the worker", () => {
    const p = parseSystemActivityLine('⚡ [SYSTEM: Spawning specialist worker.reviewer...]');
    expect(p.kind).toBe("spawn");
    expect(p.worker).toBe("worker.reviewer");
  });

  it("classifies 'Executing tool' with an 'on <target>' form", () => {
    const p = parseSystemActivityLine('⚡ [SYSTEM: Executing tool "read_file" on foo.ts (lines 1-300)...]');
    expect(p.kind).toBe("exec");
    expect(p.toolName).toBe("read_file");
    expect(p.target).toBe("foo.ts (lines 1-300)");
    expect(p.args).toBe("");
  });

  it("classifies 'Executing tool' with an 'with arguments <json>' form", () => {
    const p = parseSystemActivityLine('⚡ [SYSTEM: Executing tool "list_dir" with arguments {"path":"."}...]');
    expect(p.kind).toBe("exec");
    expect(p.toolName).toBe("list_dir");
    expect(p.target).toBe("");
    expect(p.args).toBe('{"path":"."}');
  });

  it("classifies a tool completion and extracts the result length", () => {
    const p = parseSystemActivityLine('⚡ [SYSTEM: Tool "read_file" completed with result length: 1234 characters.]');
    expect(p.kind).toBe("completed");
    expect(p.toolName).toBe("read_file");
    expect(p.len).toBe("1234");
  });

  it("classifies verification run / pass / fail", () => {
    expect(parseSystemActivityLine('⚡ [SYSTEM: Running auto-verification (gate-quick)...]')).toMatchObject({ kind: "verify-run", gate: "gate-quick" });
    expect(parseSystemActivityLine('⚡ [SYSTEM: Verification passed successfully.]').kind).toBe("verify-pass");
    expect(parseSystemActivityLine('⚡ [SYSTEM: Verification failed! Re-routing to self-heal...]').kind).toBe("verify-fail");
  });

  it("classifies a retry/countdown line (which carries no [SYSTEM:] prefix)", () => {
    const p = parseSystemActivityLine('⚠️ [Stream Failsafe Recovery] LLM request failed. Retrying in 2.5s (Attempt 1/3)...');
    expect(p.kind).toBe("retry");
    expect(p.cleanLine).toContain("Retrying in 2.5s");
  });

  it("falls back to 'system' for an unrecognised [SYSTEM:] line (e.g. the §8.10 resume notice)", () => {
    const p = parseSystemActivityLine('⚠ [SYSTEM: Reached the maximum 2 tool/continuation iterations for this turn.]');
    expect(p.kind).toBe("system");
    expect(p.cleanLine).toContain("[SYSTEM:");
  });

  it("returns 'other' (renders as null in the verbose line) for a non-system line", () => {
    expect(parseSystemActivityLine("just some assistant prose").kind).toBe("other");
  });

  it("'Executing tool' present but malformed → falls through to the [SYSTEM:] catch-all (not exec)", () => {
    // No closing quote/ellipsis → the exec regex must not match; it still contains
    // "[SYSTEM:" so it classifies as a generic system line (the original behaviour).
    const p = parseSystemActivityLine('⚡ [SYSTEM: Executing tool malformed line]');
    expect(p.kind).toBe("system");
  });
});
