import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { buildFileTreeSection, buildContextPack } from "../context/pack.js";
import { writeIndex, buildIndex } from "../index/workspace-indexer.js";
import type { RouteResult } from "../router/model-router.js";
import type { TokenBudgetPlan } from "../context/token-policy.js";

const dirs: string[] = [];

afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs.length = 0;
});

describe("pack", () => {
  it("buildFileTreeSection generates indented file tree organized by folder", () => {
    const root = mkdtempSync(join(tmpdir(), "agency-pack-"));
    dirs.push(root);
    mkdirSync(join(root, "src"), { recursive: true });
    mkdirSync(join(root, "src", "chat"), { recursive: true });
    writeFileSync(join(root, "package.json"), "{}", "utf8");
    writeFileSync(join(root, "README.md"), "# Hello", "utf8");
    writeFileSync(join(root, "src", "chat", "orchestrator.ts"), "content", "utf8");
    writeIndex(root, buildIndex(root));

    const tree = buildFileTreeSection(root);
    expect(tree).toContain("## Workspace File Tree");
    expect(tree).toContain("- package.json");
    expect(tree).toContain("- README.md");
    expect(tree).toContain("- src/");
    expect(tree).toContain("  - chat/");
    expect(tree).toContain("    - orchestrator.ts");
  });

  it("buildContextPack includes the file tree and file contents", () => {
    const root = mkdtempSync(join(tmpdir(), "agency-pack-context-"));
    dirs.push(root);
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "package.json"), "{}", "utf8");
    writeFileSync(join(root, "src", "foo.ts"), "console.log('test')", "utf8");
    writeIndex(root, buildIndex(root));

    const route: RouteResult = {
      intent: "read",
      workflow: "none",
      provider: "openai",
      skills: [],
      warnings: [],
    };

    const plan: TokenBudgetPlan = {
      mode: "normal",
      maxContextFiles: 5,
      maxContextChars: 12000,
      maxLlmOutputTokens: 1024,
      allowPreflight: false,
      includeFullRouteJson: false,
      useRouteCache: false,
    };

    const context = buildContextPack(root, route, plan);
    expect(context).toContain("# Context");
    expect(context).toContain("## Workspace File Tree");
    expect(context).toContain("- package.json");
    expect(context).toContain("- src/");
    expect(context).toContain("  - foo.ts");
  });
});
