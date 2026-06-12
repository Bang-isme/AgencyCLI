import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadManifestSkills } from "@agency/skills-bridge";
import { MANIFEST_AGENTS, toolRegistry } from "@agency/core";

/**
 * Structural-consistency guard: the canonical reference doc (`docs/PACKAGES.md`)
 * must not drift from the code it documents.
 *
 * The repo's two diseases are "built-but-unwired" and "duplication"; at the docs
 * layer they show up as **doc drift** — a tool/agent added in code but missing
 * from the reference, or a stale count word ("20 tools" after a 21st was added).
 * Nothing previously asserted doc↔code agreement, so the counts in PACKAGES.md,
 * ROADMAP §8, EVENT_FIRST, etc. silently rotted (verified 2026-06-05: ROADMAP §8
 * said "33 cờ · 20 tool · core 424" while the live numbers were 41/21/496).
 *
 * This guard pins only the STABLE structural facts (tool names, agent ids,
 * package count, skill/workflow counts) against PACKAGES.md — the designated
 * module reference. VOLATILE counts (per-package test totals, the flag count)
 * are deliberately NOT pinned here: they change every slice and live via
 * `pnpm verify` + `agency status` (the single live source), per
 * docs/SESSION_HANDOFF_PROMPT.md and docs/COMPLETION_CONTRACT.md. Pinning them
 * would only move the drift into this file.
 *
 * Reuses the real exports (`toolRegistry`, `MANIFEST_AGENTS`, `loadManifestSkills`)
 * rather than re-deriving counts, and lives in @agency/cli because it sits atop
 * the dep graph (can import core) and bundles the skills pack. Mirrors
 * `skills-manifest-integrity.test.ts`.
 */

const PKG_ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "../..");
const REPO_ROOT = join(PKG_ROOT, "..", "..");
const PACKAGES_MD = join(REPO_ROOT, "docs", "PACKAGES.md");
const SKILLS_ROOT = join(PKG_ROOT, "skills");
const MANIFEST_PATH = join(SKILLS_ROOT, ".system", "manifest.json");

function packagesMd(): string {
  return readFileSync(PACKAGES_MD, "utf8");
}

/** Count workspace packages on disk (dirs under `packages/` with a package.json). */
function diskPackageCount(): number {
  const dir = join(REPO_ROOT, "packages");
  return readdirSync(dir).filter((name) => {
    try {
      return (
        statSync(join(dir, name)).isDirectory() &&
        existsSync(join(dir, name, "package.json"))
      );
    } catch {
      return false;
    }
  }).length;
}

/** A count word like "21 tools" / "16 packages" must appear verbatim in the doc. */
function expectCountPhrase(doc: string, n: number, nouns: string[]): void {
  const hit = nouns.some((noun) => doc.includes(`${n} ${noun}`));
  expect(
    hit,
    `docs/PACKAGES.md must state "${n} ${nouns[0]}" (got none of: ${nouns
      .map((nn) => `"${n} ${nn}"`)
      .join(", ")}). Update PACKAGES.md to the live count.`
  ).toBe(true);
}

if (existsSync(PACKAGES_MD)) {
  describe("docs/PACKAGES.md ↔ code consistency", () => {
    it("the reference doc exists", () => {
      expect(existsSync(PACKAGES_MD)).toBe(true);
    });

    it("every built-in tool is documented (no built-but-undocumented tool)", () => {
      const doc = packagesMd();
      const toolNames = toolRegistry.listTools().map((t) => t.name);
      const undocumented = toolNames.filter((n) => !doc.includes(`\`${n}\``));
      expect(
        undocumented,
        `These registered tools are missing from docs/PACKAGES.md: ${undocumented.join(", ")}`
      ).toEqual([]);
    });

    it("states the correct built-in tool count", () => {
      const n = toolRegistry.listTools().length;
      expectCountPhrase(packagesMd(), n, ["tools", "built-in tool", "built-in tools"]);
    });

    it("every manifest agent is documented (no built-but-undocumented agent)", () => {
      const doc = packagesMd();
      const undocumented = MANIFEST_AGENTS.filter((a) => !doc.includes(a));
      expect(
        undocumented,
        `These manifest agents are missing from docs/PACKAGES.md: ${undocumented.join(", ")}`
      ).toEqual([]);
    });

    it("states the correct agent count", () => {
      expectCountPhrase(packagesMd(), MANIFEST_AGENTS.length, ["agents", "agent"]);
    });

    it("states the correct workspace package count", () => {
      expectCountPhrase(packagesMd(), diskPackageCount(), ["packages"]);
    });

    it("states the correct skill and workflow counts", () => {
      const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8")) as {
        workflows?: string[];
      };
      const skillCount = loadManifestSkills(SKILLS_ROOT).length;
      const workflowCount = manifest.workflows?.length ?? 0;
      const doc = packagesMd();
      expectCountPhrase(doc, skillCount, ["skills"]);
      expectCountPhrase(doc, workflowCount, ["workflows"]);
    });
  });
} else {
  describe("docs/PACKAGES.md ↔ code consistency (Skipped)", () => {
    it("skips because docs/PACKAGES.md is not present on disk", () => {
      // noop
    });
  });
}
