import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const cliDir = dirname(fileURLToPath(import.meta.url));
const cliEntry = join(cliDir, "..", "..", "dist", "index.js");
const repoRoot = join(cliDir, "..", "..", "..", "..");

describe("agency chat", () => {
  it("prints human-formatted output without JSON by default", () => {
    const originalUserProfile = process.env.USERPROFILE ?? "";
    let skillsRoot = process.env.AGENCY_SKILLS_ROOT;
    if (!skillsRoot) {
      for (const folder of [join(".agency", "skills"), join(".cursor", "skills-cursor"), join(".codex", "skills")]) {
        const candidate = join(originalUserProfile, folder);
        if (existsSync(join(candidate, ".system", "manifest.json"))) {
          skillsRoot = candidate;
          break;
        }
      }
      if (!skillsRoot) {
        skillsRoot = join(originalUserProfile, ".agency", "skills");
      }
    }

    const tempHome = mkdtempSync(join(tmpdir(), "agency-chat-home-"));
    try {
      const env = {
        ...process.env,
        HOME: tempHome,
        USERPROFILE: tempHome,
        AGENCY_SKILLS_ROOT: skillsRoot,
      };
      const result = execFileSync(
        process.execPath,
        [cliEntry, "chat", "smoke test route", "--no-llm", "--quiet"],
        {
          cwd: repoRoot,
          env,
          encoding: "utf8",
          timeout: 120_000,
        }
      );
      expect(result).toContain("intent");
      expect(result).not.toMatch(/\{\s*"intent"/);
    } finally {
      rmSync(tempHome, { recursive: true, force: true });
    }
  });
});
