import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RouteResult } from "../router/model-router.js";
import type { ReplayEvent } from "@agency/contracts";

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
import { describeToolActivity } from "../chat/turn-helpers.js";
import { EventBus } from "../events/event-bus.js";
import { closeAllDbs } from "@agency/memory";

describe("§8.10-A describeToolActivity (pure)", () => {
  it("maps a read to Reading + retrieval, keeping the structured target (no regex)", () => {
    const a = describeToolActivity("read_file", "read_file: foo.ts (lines 1-300)");
    expect(a.message).toBe("Reading foo.ts (lines 1-300)");
    expect(a.source).toBe("retrieval");
    expect(a.phase).toBe("retrieval");
    expect(a.severity).toBe("info");
    expect(a.confidence).toBe("high");
  });

  it("maps a search to Searching + retrieval", () => {
    expect(describeToolActivity("grep_search", "grep_search: TODO").message).toBe("Searching TODO");
    expect(describeToolActivity("grep_search", "grep_search: TODO").source).toBe("retrieval");
  });

  it("maps a write/edit (incl. delete/move/mkdir) to Editing + worker/editing", () => {
    expect(describeToolActivity("write_file", "write_file: page.html").message).toBe("Editing page.html");
    expect(describeToolActivity("append_file", "append_file: page.html").message).toBe("Editing page.html");
    expect(describeToolActivity("delete_file", "delete_file: old.txt").message).toBe("Editing old.txt");
    const w = describeToolActivity("edit_file", "edit_file: a.ts");
    expect(w.source).toBe("worker");
    expect(w.phase).toBe("editing");
  });

  it("maps exec to Running + sandbox, and dispatch to Spawning subagent", () => {
    expect(describeToolActivity("execute_command", "execute_command: npm test").message).toBe("Running npm test");
    expect(describeToolActivity("execute_command", "execute_command: npm test").source).toBe("sandbox");
    // dispatch_subagent's step label carries no path/command target → verb only.
    expect(describeToolActivity("dispatch_subagent", "dispatch_subagent: ").message).toBe("Spawning subagent");
    expect(describeToolActivity("dispatch_subagent", "dispatch_subagent: ").phase).toBe("planning");
  });

  it("falls back to the raw step label for an unknown / MCP tool (never silent)", () => {
    const a = describeToolActivity("mcp_jira_create", "mcp_jira_create: PROJ-1");
    expect(a.message).toBe("mcp_jira_create: PROJ-1");
    expect(a.source).toBe("worker");
  });
});

describe("§8.10-A main-turn tool narration wiring (cognitionStream)", () => {
  let root: string;
  const prev = process.env.AGENCY_COGNITION_STREAM;
  const bus = EventBus.getInstance();

  /** Collect thought:emitted messages while running `fn`, then unsubscribe. */
  async function captureThoughts(fn: () => Promise<unknown>): Promise<string[]> {
    const messages: string[] = [];
    const onThought = (e: ReplayEvent) => {
      const p = JSON.parse(e.payload) as { message?: string };
      if (p.message) messages.push(p.message);
    };
    bus.subscribe("thought:emitted", onThought);
    try {
      await fn();
      // thought:emitted is published fire-and-forget (`void publish`) → drain.
      for (let i = 0; i < 50; i++) await new Promise((r) => setImmediate(r));
    } finally {
      bus.unsubscribe("thought:emitted", onThought);
    }
    return messages;
  }

  const route: RouteResult = {
    intent: "build",
    suggested_agent: null,
    workflow: "implement",
    skills: [],
    provider: "openrouter",
    warnings: [],
  };

  /** A provider that writes a file on the first call, then finishes. */
  function writeThenDone(path: string) {
    let calls = 0;
    return {
      id: "openrouter" as const,
      complete: vi.fn(async () => {
        calls++;
        if (calls === 1) {
          return `Writing:\n<tool_call name="write_file">\n  <path>${path}</path>\n  <content>hello world</content>\n</tool_call>`;
        }
        return "Done.";
      }),
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    root = mkdtempSync(join(tmpdir(), "agency-toolnarr-"));
    clearRouteCache(root);
    vi.mocked(routeUserPrompt).mockResolvedValue(route);
    vi.mocked(providers.loadAgencyConfig).mockReturnValue({
      defaultProvider: "openrouter",
      providers: { openrouter: { apiKey: "key", model: "gpt-4o-mini" } },
    });
  });

  afterEach(() => {
    closeAllDbs();
    if (existsSync(root)) rmSync(root, { recursive: true, force: true });
    if (prev === undefined) delete process.env.AGENCY_COGNITION_STREAM;
    else process.env.AGENCY_COGNITION_STREAM = prev;
  });

  it("flag ON: a main-turn tool emits a structured 'Editing <file>' narration", async () => {
    process.env.AGENCY_COGNITION_STREAM = "1";
    vi.mocked(providers.getProvider).mockReturnValue(writeThenDone("page.html"));

    const messages = await captureThoughts(() =>
      runChatTurnWithStream(
        { prompt: "build page.html", projectRoot: root, skillsRoot: "/skills", sessionId: "narr-on", noVerify: true },
        { onRoute: () => {}, onDelta: () => {} }
      )
    );

    expect(messages).toContain("Editing page.html");
  });

  it("flag OFF (legacy): no thought is emitted at all (byte-identical, no narration)", async () => {
    delete process.env.AGENCY_COGNITION_STREAM; // legacy default = off
    vi.mocked(providers.getProvider).mockReturnValue(writeThenDone("page.html"));

    const messages = await captureThoughts(() =>
      runChatTurnWithStream(
        { prompt: "build page.html", projectRoot: root, skillsRoot: "/skills", sessionId: "narr-off", noVerify: true },
        { onRoute: () => {}, onDelta: () => {} }
      )
    );

    expect(messages).toHaveLength(0);
  });

  it("flag ON + agentId set (subagent): no tool-activity narration (goes to the worker panel instead)", async () => {
    process.env.AGENCY_COGNITION_STREAM = "1";
    vi.mocked(providers.getProvider).mockReturnValue(writeThenDone("page.html"));

    const messages = await captureThoughts(() =>
      runChatTurnWithStream(
        { prompt: "build page.html", projectRoot: root, skillsRoot: "/skills", sessionId: "narr-agent", agentId: "worker-1", noVerify: true },
        { onRoute: () => {}, onDelta: () => {} }
      )
    );

    // Routing may still narrate, but the tool itself must NOT (agentId → subagent:progress).
    expect(messages.some((m) => m.includes("page.html"))).toBe(false);
  });
});
