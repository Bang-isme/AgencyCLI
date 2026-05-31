import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPO_ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "../../../..");
const BUNDLED_SKILLS_ROOT = join(REPO_ROOT, "packages", "cli", "skills");

describe("bundled skills pack portability", () => {
  it("does not ship generated project-local .codex state", () => {
    expect(existsSync(join(BUNDLED_SKILLS_ROOT, "codex-project-memory", ".codex"))).toBe(false);
  });
});
