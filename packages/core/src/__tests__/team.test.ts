import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import {
  addMember,
  initTeam,
  loadTeam,
  removeMember,
  TeamAlreadyExistsError,
  TeamMemberExistsError,
  TeamMemberNotFoundError,
  teamConfigPath,
} from "../team/store.js";

describe("team store", () => {
  it("initTeam writes .agency/team.json with defaults", () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "agency-team-"));
    try {
      const config = initTeam(projectRoot, "My Team");
      expect(config.version).toBe(1);
      expect(config.teamName).toBe("My Team");
      expect(config.members).toEqual([]);
      expect(config.policies.requireApprovalForDeploy).toBe(true);

      const path = teamConfigPath(projectRoot);
      expect(existsSync(path)).toBe(true);
      const onDisk = JSON.parse(readFileSync(path, "utf8")) as {
        teamName: string;
      };
      expect(onDisk.teamName).toBe("My Team");
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it("initTeam rejects duplicate config", () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "agency-team-dup-"));
    try {
      initTeam(projectRoot, "First");
      expect(() => initTeam(projectRoot, "Second")).toThrow(TeamAlreadyExistsError);
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it("addMember and removeMember round-trip", () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "agency-team-members-"));
    try {
      initTeam(projectRoot, "Crew");
      const afterAdd = addMember(projectRoot, {
        id: "u1",
        name: "Alice",
        role: "dev",
        email: "alice@example.com",
      });
      expect(afterAdd.members).toHaveLength(1);
      expect(afterAdd.members[0]?.name).toBe("Alice");

      expect(() =>
        addMember(projectRoot, { id: "u1", name: "Dup", role: "qa" })
      ).toThrow(TeamMemberExistsError);

      const afterRemove = removeMember(projectRoot, "u1");
      expect(afterRemove.members).toHaveLength(0);
      expect(() => removeMember(projectRoot, "u1")).toThrow(TeamMemberNotFoundError);

      expect(loadTeam(projectRoot)?.members).toEqual([]);
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it("loadTeam returns null when missing", () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "agency-team-missing-"));
    try {
      expect(loadTeam(projectRoot)).toBeNull();
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});
