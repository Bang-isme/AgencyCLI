import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getWorkspaceReadiness } from "../product/workspace-readiness.js";

describe("workspace readiness", () => {
  it("reports a non-repository as optional instead of ready", async () => {
    const root = mkdtempSync(join(tmpdir(), "agency-readiness-"));
    try {
      const checks = await getWorkspaceReadiness(root);
      expect(checks.find((check) => check.id === "git")).toMatchObject({ state: "optional" });
      expect(checks.find((check) => check.id === "git")?.recovery).toContain("Initialize Git");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
