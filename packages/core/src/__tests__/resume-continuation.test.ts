import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RouteResult } from "../router/model-router.js";

vi.mock("../router/model-router.js", () => ({
  routeUserPrompt: vi.fn(),
}));

vi.mock("@agency/providers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@agency/providers")>();
  return {
    ...actual,
    loadAgencyConfig: vi.fn(),
    getProvider: vi.fn(),
    updateModelOverride: vi.fn(),
  };
});

import * as providers from "@agency/providers";
import { routeUserPrompt } from "../router/model-router.js";
import { clearRouteCache } from "../context/session-cache.js";
import { runChatTurnWithStream } from "../chat/stream.js";
import { runChatTurn } from "../chat/orchestrator.js";
import { buildIncompleteTurnNotice } from "../chat/turn-helpers.js";
import { closeAllDbs } from "@agency/memory";

const mockedRoute = vi.mocked(routeUserPrompt);
const mockedConfig = vi.mocked(providers.loadAgencyConfig);
const mockedGetProvider = vi.mocked(providers.getProvider);

const route: RouteResult = {
  intent: "build",
  suggested_agent: null,
  workflow: "implement",
  skills: [],
  provider: "openrouter",
  warnings: [],
};

/** A provider that NEVER finishes: every completion is another write tool call,
 * so the outer loop runs until it hits maxLoops. */
function neverFinishingWriter(path: string) {
  return {
    id: "openrouter" as const,
    complete: vi.fn(async () =>
      `Writing a chunk:\n<tool_call name="write_file">\n  <path>${path}</path>\n  <content>chunk of content</content>\n</tool_call>`
    ),
  };
}

describe("§8.10 buildIncompleteTurnNotice (pure)", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "agency-resume-notice-"));
  });
  afterEach(() => {
    if (existsSync(root)) rmSync(root, { recursive: true, force: true });
  });

  it("lists each modified file with its on-disk size + a single-line resume instruction", () => {
    writeFileSync(join(root, "page.html"), "line1\nline2\nline3\n", "utf8");
    const notice = buildIncompleteTurnNotice(["page.html"], root, 15);

    // Single [SYSTEM:] line carries the gist (model + TUI activity parser see it).
    expect(notice).toContain("[SYSTEM:");
    expect(notice).toContain("maximum 15 tool/continuation iterations");
    expect(notice).toContain('send "continue"');
    expect(notice).toMatch(/do NOT rewrite a file from scratch/i);
    // Readable appendix with real on-disk state.
    expect(notice).toContain("page.html");
    expect(notice).toContain("4 lines"); // 3 lines + trailing newline → split() length 4
    expect(notice).toContain("bytes");
  });

  it("dedupes repeated paths and survives a missing file (best-effort, never throws)", () => {
    const notice = buildIncompleteTurnNotice(["gone.txt", "gone.txt"], root, 8);
    // Only one bullet for the deduped path; no throw despite the missing file.
    expect(notice.match(/gone\.txt/g)?.length).toBe(1);
    expect(notice).toContain("Modified 1 file(s)");
  });

  it("falls back to a generic continue prompt when no files were modified", () => {
    const notice = buildIncompleteTurnNotice([], root, 3);
    expect(notice).toContain("[SYSTEM:");
    expect(notice).toContain('send "continue"');
    expect(notice).not.toContain("Files modified this turn");
  });
});

describe("§8.10 resume-continuation wiring (loop exhaustion)", () => {
  let root: string;
  const prev = process.env.AGENCY_RESUME_CONTINUATION;

  beforeEach(() => {
    vi.clearAllMocks();
    root = mkdtempSync(join(tmpdir(), "agency-resume-"));
    clearRouteCache(root);
    mockedRoute.mockResolvedValue(route);
    mockedConfig.mockReturnValue({
      defaultProvider: "openrouter",
      providers: { openrouter: { apiKey: "key", model: "gpt-4o-mini" } },
    });
  });

  afterEach(() => {
    closeAllDbs();
    if (existsSync(root)) rmSync(root, { recursive: true, force: true });
    if (prev === undefined) delete process.env.AGENCY_RESUME_CONTINUATION;
    else process.env.AGENCY_RESUME_CONTINUATION = prev;
  });

  it("flag ON: folds the resume notice (with the modified file) into assistantText + streams it", async () => {
    process.env.AGENCY_RESUME_CONTINUATION = "1";
    mockedGetProvider.mockReturnValue(neverFinishingWriter("page.html"));
    const deltas: string[] = [];

    const result = await runChatTurnWithStream(
      { prompt: "write a big page.html", projectRoot: root, skillsRoot: "/skills", sessionId: "s-on", maxLoops: 2, noVerify: true },
      { onRoute: () => {}, onDelta: (d) => deltas.push(d) }
    );

    expect(result.assistantText).toContain("[SYSTEM: Reached the maximum 2 tool/continuation iterations");
    expect(result.assistantText).toContain("page.html");
    expect(result.assistantText).toMatch(/do NOT rewrite a file from scratch/i);
    expect(deltas.join("")).toContain("Reached the maximum 2");
    // The legacy generic notice must NOT appear when the resume notice is on.
    expect(result.assistantText).not.toContain("Response truncated");
  });

  it("flag OFF (opt-out): generic truncation notice only, nothing folded into assistantText (legacy path preserved)", async () => {
    process.env.AGENCY_RESUME_CONTINUATION = "0"; // explicit opt-out (now on by default)
    mockedGetProvider.mockReturnValue(neverFinishingWriter("page.html"));
    const deltas: string[] = [];

    const result = await runChatTurnWithStream(
      { prompt: "write a big page.html", projectRoot: root, skillsRoot: "/skills", sessionId: "s-off", maxLoops: 2, noVerify: true },
      { onRoute: () => {}, onDelta: (d) => deltas.push(d) }
    );

    // Legacy behaviour: streamed-only truncation notice, never persisted.
    expect(deltas.join("")).toContain("Response truncated");
    expect(result.assistantText).not.toContain("[SYSTEM: Reached the maximum");
    expect(result.assistantText).not.toContain("send \"continue\"");
  });

  it("flag ON: non-stream runChatTurn also folds the notice into assistantText", async () => {
    process.env.AGENCY_RESUME_CONTINUATION = "1";
    mockedGetProvider.mockReturnValue(neverFinishingWriter("doc.md"));

    const result = await runChatTurn({
      prompt: "write a big doc.md",
      projectRoot: root,
      skillsRoot: "/skills",
      sessionId: "s-plain",
      maxLoops: 2,
      noVerify: true,
    });

    expect(result.assistantText).toContain("[SYSTEM: Reached the maximum 2 tool/continuation iterations");
    expect(result.assistantText).toContain("doc.md");
  });
});
