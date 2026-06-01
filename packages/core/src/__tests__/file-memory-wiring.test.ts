import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeTool } from "../skill/tool-harness.js";
import { loadHistoricalMemories } from "../chat/memory-integration.js";
import { buildSystemPrompt } from "../chat/prompt.js";
import { closeAllDbs } from "@agency/memory";
import type { RouteResult } from "../router/model-router.js";

const route: RouteResult = {
  intent: "build",
  suggested_agent: null,
  workflow: "implement",
  skills: [],
  provider: "openrouter",
  warnings: [],
};

describe("§file-memory wiring (remember tool + markdown recall + flag gating)", () => {
  let root: string;
  const prev = process.env.AGENCY_FILE_MEMORY;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "agency-filemem-"));
  });
  afterEach(() => {
    closeAllDbs();
    if (existsSync(root)) rmSync(root, { recursive: true, force: true });
    if (prev === undefined) delete process.env.AGENCY_FILE_MEMORY;
    else process.env.AGENCY_FILE_MEMORY = prev;
  });

  it("the `remember` tool persists a memory file under .agency/memory", async () => {
    const res = await executeTool(
      "remember",
      { description: "User prefers pnpm", content: "Always use pnpm, never npm.", type: "user" },
      root,
      "/skills"
    );
    expect(res).toMatch(/Success: Saved memory/);
    expect(existsSync(join(root, ".agency", "memory", "user-prefers-pnpm.md"))).toBe(true);
    expect(existsSync(join(root, ".agency", "memory", "MEMORY.md"))).toBe(true);
  });

  it("flag ON: a saved memory is recalled into the historical-memories block", async () => {
    process.env.AGENCY_FILE_MEMORY = "1";
    await executeTool(
      "remember",
      { description: "Auth uses JWT", content: "Tokens are verified in middleware/auth.ts", type: "project" },
      root,
      "/skills"
    );
    const recall = await loadHistoricalMemories(root, "how does authentication work", "sess-1");
    expect(recall).toContain("curated, durable memories");
    expect(recall).toContain("Tokens are verified in middleware/auth.ts");
  });

  it("flag OFF (legacy): markdown memory is NOT recalled (byte-identical empty recall)", async () => {
    delete process.env.AGENCY_FILE_MEMORY; // legacy default off
    await executeTool(
      "remember",
      { description: "Auth uses JWT", content: "secret recall marker zzz", type: "project" },
      root,
      "/skills"
    );
    const recall = await loadHistoricalMemories(root, "how does authentication work", "sess-1");
    // Memory was written, but legacy recall must not surface it.
    expect(recall).not.toContain("secret recall marker zzz");
    expect(recall).not.toContain("curated, durable memories");
  });

  it("flag ON: the `remember` tool + memory protocol appear in the system prompt; OFF: neither", () => {
    process.env.AGENCY_FILE_MEMORY = "1";
    const on = buildSystemPrompt(route, "hi", "", root);
    expect(on).toContain("`remember`");
    expect(on).toContain("PERSISTENT MEMORY PROTOCOL");

    delete process.env.AGENCY_FILE_MEMORY;
    const off = buildSystemPrompt(route, "hi", "", root);
    expect(off).not.toContain("PERSISTENT MEMORY PROTOCOL");
    // The remember tool must not be advertised in the legacy tool docs.
    expect(off).not.toMatch(/\d+\.\s+`remember`/);
  });
});
