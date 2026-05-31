import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { extractTldr, parseSkillMd } from "../skill-md.js";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "../../../..");
const FIXTURE_SKILL = join(
  ROOT,
  "tests",
  "fixtures",
  "mock-skills",
  "codex-demo",
  "SKILL.md"
);

describe("parseSkillMd", () => {
  it("parses YAML frontmatter name and description", () => {
    const parsed = parseSkillMd(FIXTURE_SKILL);
    expect(parsed.name).toBe("codex-demo");
    expect(parsed.description).toBe(
      "Minimal fixture skill for Agency CLI skill-md parser tests."
    );
    expect(parsed.body).toContain("## TL;DR");
    expect(parsed.body).toContain("Fixture body for vitest.");
  });

  it("extracts TL;DR section from body", () => {
    const parsed = parseSkillMd(FIXTURE_SKILL);
    const tldr = extractTldr(parsed.body);
    expect(tldr).toContain("Demo skill for unit tests");
  });
});
