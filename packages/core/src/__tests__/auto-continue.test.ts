import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
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
import { detectIncompleteCompletion, detectTruncatedArtifact, MAX_AUTO_CONTINUE } from "../chat/turn-helpers.js";
import { mkdtempSync as mkdtmp, writeFileSync as writeF } from "node:fs";
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

describe("detectIncompleteCompletion (pure)", () => {
  it("fires on an end-of-message first-person continuation promise", () => {
    expect(
      detectIncompleteCompletion("I've set up the structure. I'll now implement the remaining handlers.")
    ).toBe(true);
    expect(detectIncompleteCompletion("Next, I'll create the config file and wire it up.")).toBe(true);
    expect(detectIncompleteCompletion("Good progress so far. Let me continue with the routes.")).toBe(true);
  });

  it("fires on an explicit 'to be continued' marker", () => {
    expect(detectIncompleteCompletion("Part 1 done. (to be continued)")).toBe(true);
  });

  it("fires on a left-in code placeholder regardless of surrounding text", () => {
    expect(
      detectIncompleteCompletion("```js\nfunction f() {\n  // ... rest of the code\n}\n```")
    ).toBe(true);
    expect(detectIncompleteCompletion("# ... remaining implementation below")).toBe(true);
    expect(detectIncompleteCompletion("class A {\n  // ... existing code ...\n}")).toBe(true);
  });

  it("does NOT fire on a genuinely-complete turn", () => {
    expect(detectIncompleteCompletion("Here's the full solution. The implementation is complete.")).toBe(false);
    expect(detectIncompleteCompletion("Done — all files created and the build passes.")).toBe(false);
    expect(detectIncompleteCompletion("")).toBe(false);
  });

  it("does NOT fire on an offer/question to the user (not an in-progress promise)", () => {
    expect(detectIncompleteCompletion("All set. Let me know if you'd like me to continue with tests.")).toBe(false);
    expect(detectIncompleteCompletion("Should I continue with the integration tests?")).toBe(false);
    expect(detectIncompleteCompletion("Would you like me to add error handling next?")).toBe(false);
  });

  it("does NOT fire on a mid-message 'we should' explanation (no first-person promise in the tail)", () => {
    expect(
      detectIncompleteCompletion(
        "I refactored the parser. Next we should consider caching, but that is optional and out of scope here."
      )
    ).toBe(false);
  });
});

describe("detectTruncatedArtifact (on-disk, pure)", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtmp(join(tmpdir(), "agency-artifact-"));
  });
  afterEach(() => {
    if (existsSync(root)) rmSync(root, { recursive: true, force: true });
  });

  it("fires when a written file contains a truncation/elision placeholder", () => {
    writeF(join(root, "a.ts"), "export function f() {\n  // ... rest of the code\n}\n", "utf8");
    expect(detectTruncatedArtifact(["a.ts"], root)).toBe(true);
  });

  it("fires on the '... existing code ...' elision marker", () => {
    writeF(join(root, "b.ts"), "class B {\n  # ... existing code ...\n}\n", "utf8");
    expect(detectTruncatedArtifact(["b.ts"], root)).toBe(true);
  });

  it("does NOT fire on a complete file, and never throws on a missing one", () => {
    writeF(join(root, "c.ts"), "export const x = 1;\nexport const y = 2;\n", "utf8");
    expect(detectTruncatedArtifact(["c.ts"], root)).toBe(false);
    expect(detectTruncatedArtifact(["gone.ts"], root)).toBe(false);
  });
});

describe("auto-continue wiring (unfinished natural stop)", () => {
  let root: string;
  const prev = process.env.AGENCY_AUTO_CONTINUE;

  beforeEach(() => {
    vi.clearAllMocks();
    root = mkdtempSync(join(tmpdir(), "agency-autocontinue-"));
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
    if (prev === undefined) delete process.env.AGENCY_AUTO_CONTINUE;
    else process.env.AGENCY_AUTO_CONTINUE = prev;
  });

  // A provider that always emits a no-tool-call "I'll continue" promise — it
  // never finishes on its own, so only the bound stops the loop.
  function alwaysPromising() {
    return {
      id: "openrouter" as const,
      complete: vi.fn(async () => "Started the work. I'll continue creating the remaining files."),
    };
  }

  it("flag ON: auto-continues up to MAX_AUTO_CONTINUE then stops (bounded, not maxLoops)", async () => {
    process.env.AGENCY_AUTO_CONTINUE = "1";
    const provider = alwaysPromising();
    mockedGetProvider.mockReturnValue(provider);

    await runChatTurnWithStream(
      { prompt: "build a multi-file app", projectRoot: root, skillsRoot: "/skills", sessionId: "s-on", maxLoops: 10, noVerify: true },
      { onRoute: () => {}, onDelta: () => {} }
    );

    // 1 initial completion + MAX_AUTO_CONTINUE auto-continues, then the bound trips
    // and the loop ends — well short of maxLoops=10.
    expect(provider.complete).toHaveBeenCalledTimes(1 + MAX_AUTO_CONTINUE);
  });

  it("flag OFF (opt-out): a no-tool-call turn ends the loop immediately (legacy path preserved)", async () => {
    process.env.AGENCY_AUTO_CONTINUE = "0"; // explicit opt-out (now on by default)
    const provider = alwaysPromising();
    mockedGetProvider.mockReturnValue(provider);

    await runChatTurnWithStream(
      { prompt: "build a multi-file app", projectRoot: root, skillsRoot: "/skills", sessionId: "s-off", maxLoops: 10, noVerify: true },
      { onRoute: () => {}, onDelta: () => {} }
    );

    expect(provider.complete).toHaveBeenCalledTimes(1);
  });

  it("flag ON: a genuinely-complete turn still ends after one completion (no needless continue)", async () => {
    process.env.AGENCY_AUTO_CONTINUE = "1";
    const provider = {
      id: "openrouter" as const,
      complete: vi.fn(async () => "All files created and the build passes. The implementation is complete."),
    };
    mockedGetProvider.mockReturnValue(provider);

    await runChatTurnWithStream(
      { prompt: "do a small fix", projectRoot: root, skillsRoot: "/skills", sessionId: "s-done", maxLoops: 10, noVerify: true },
      { onRoute: () => {}, onDelta: () => {} }
    );

    expect(provider.complete).toHaveBeenCalledTimes(1);
  });

  it("flag ON: non-stream runChatTurn auto-continues with the same bound", async () => {
    process.env.AGENCY_AUTO_CONTINUE = "1";
    const provider = alwaysPromising();
    mockedGetProvider.mockReturnValue(provider);

    await runChatTurn({
      prompt: "build a multi-file app",
      projectRoot: root,
      skillsRoot: "/skills",
      sessionId: "s-plain",
      maxLoops: 10,
      noVerify: true,
    });

    expect(provider.complete).toHaveBeenCalledTimes(1 + MAX_AUTO_CONTINUE);
  });

  it("flag ON: an on-disk stub triggers one continue even when the prose looks done; stops once fixed", async () => {
    process.env.AGENCY_AUTO_CONTINUE = "1";
    // iter1 writes a file with a placeholder; iter2 says a clean "Done." (prose
    // alone wouldn't trigger) → artifact scan finds the stub → continue; iter3
    // overwrites with clean content; iter4 "Done." → no stub → loop ends.
    let calls = 0;
    const provider = {
      id: "openrouter" as const,
      complete: vi.fn(async () => {
        calls++;
        if (calls === 1) {
          return 'Creating it:\n<tool_call name="write_file">\n  <path>app.ts</path>\n  <content>export function f() {\n  // ... rest of the code\n}</content>\n</tool_call>';
        }
        if (calls === 2) {
          return "Done."; // clean prose, but the file still has the placeholder
        }
        if (calls === 3) {
          return 'Finishing it:\n<tool_call name="write_file">\n  <path>app.ts</path>\n  <content>export function f() {\n  return 42;\n}</content>\n</tool_call>';
        }
        return "Done — the implementation is complete.";
      }),
    };
    mockedGetProvider.mockReturnValue(provider);

    await runChatTurnWithStream(
      { prompt: "write app.ts in full", projectRoot: root, skillsRoot: "/skills", sessionId: "s-artifact", maxLoops: 10, noVerify: true },
      { onRoute: () => {}, onDelta: () => {} }
    );

    // write-stub + "Done"(triggers) + write-fix + "Done"(no trigger → break) = 4.
    expect(provider.complete).toHaveBeenCalledTimes(4);
  });
});
