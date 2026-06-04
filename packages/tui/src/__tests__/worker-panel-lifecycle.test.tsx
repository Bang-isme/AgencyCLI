import { describe, it, expect, afterEach } from "vitest";
import { render } from "ink-testing-library";
import { Box } from "ink";
import { calculateFormattedLines } from "../components/Conversation.js";
import { getTheme, DEFAULT_THEME_ID } from "../themes/registry.js";
import type { SessionMessage } from "../state/messages.js";
import type { SubagentStatus } from "../state/subagent-status.js";

const theme = getTheme(DEFAULT_THEME_ID);

const MSGS: SessionMessage[] = [
  { id: "m1", role: "assistant", timestamp: 1, content: "Working on it." },
];

function frameFor(subagents: SubagentStatus[], loading: boolean): string {
  const lines = calculateFormattedLines(
    MSGS,
    80,
    theme,
    null,
    subagents,
    loading,
    false,
    undefined,
    false
  );
  const { lastFrame } = render(
    <Box flexDirection="column">
      {lines.map((l) => (
        <Box key={l.key}>{l.element}</Box>
      ))}
    </Box>
  );
  return lastFrame() ?? "";
}

describe("Workers panel lifecycle (AGENCY_WORKER_LIFECYCLE)", () => {
  const prev = process.env.AGENCY_WORKER_LIFECYCLE;
  const prevAnim = process.env.AGENCY_TUI_ANIMATIONS;
  afterEach(() => {
    if (prev === undefined) delete process.env.AGENCY_WORKER_LIFECYCLE;
    else process.env.AGENCY_WORKER_LIFECYCLE = prev;
    if (prevAnim === undefined) delete process.env.AGENCY_TUI_ANIMATIONS;
    else process.env.AGENCY_TUI_ANIMATIONS = prevAnim;
  });

  it("flag ON, turn still running: shows the full live multi-row panel", () => {
    process.env.AGENCY_WORKER_LIFECYCLE = "1";
    process.env.AGENCY_TUI_ANIMATIONS = "0";
    const frame = frameFor(
      [
        { agentId: "frontend-specialist", task: "ui", status: "running", elapsedMs: 5000 },
        { agentId: "security-auditor", task: "audit", status: "done", elapsedMs: 2000 },
      ],
      true
    );
    expect(frame).toContain("Workers");
    expect(frame).toContain("1 active");
    expect(frame).toContain("worker.frontend-specialist");
  });

  it("flag ON, idle + all terminal: collapses to one terse summary line (no per-worker rows)", () => {
    process.env.AGENCY_WORKER_LIFECYCLE = "1";
    process.env.AGENCY_TUI_ANIMATIONS = "0";
    const frame = frameFor(
      [
        { agentId: "frontend-specialist", task: "ui", status: "done", elapsedMs: 5000 },
        { agentId: "security-auditor", task: "audit", status: "error", elapsedMs: 2000 },
        { agentId: "test-engineer", task: "tests", status: "interrupted", elapsedMs: 3000 },
      ],
      false
    );
    // Terse digest, honest counts, no per-worker detail rows or footer.
    expect(frame).toContain("Workers");
    expect(frame).toContain("1 done");
    expect(frame).toContain("1 failed");
    expect(frame).toContain("1 stopped");
    expect(frame).not.toContain("worker.frontend-specialist");
    expect(frame).not.toContain("ctrl+o");
  });

  it("flag ON: an interrupted worker never renders a live 'running' label", () => {
    process.env.AGENCY_WORKER_LIFECYCLE = "1";
    process.env.AGENCY_TUI_ANIMATIONS = "0";
    // Still loading so the full panel renders, with one interrupted worker.
    const frame = frameFor(
      [{ agentId: "frontend-specialist", task: "ui", status: "interrupted", elapsedMs: 1014000 }],
      true
    );
    expect(frame).toContain("stopped");
    expect(frame).not.toContain("[running");
  });

  it("flag OFF: legacy always-on panel — no collapse even when idle and terminal", () => {
    process.env.AGENCY_WORKER_LIFECYCLE = "0";
    process.env.AGENCY_TUI_ANIMATIONS = "0";
    const frame = frameFor(
      [
        { agentId: "frontend-specialist", task: "ui", status: "done", elapsedMs: 5000 },
        { agentId: "security-auditor", task: "audit", status: "error", elapsedMs: 2000 },
      ],
      false
    );
    // Legacy renders the full per-worker panel regardless of idle state.
    expect(frame).toContain("worker.frontend-specialist");
    expect(frame).toContain("worker.security-auditor");
  });
});
