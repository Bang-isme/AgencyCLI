import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  TeamConfig,
  TeamConfigSchema,
  TeamMember,
  TeamMemberSchema,
} from "./schema.js";

export class TeamNotFoundError extends Error {
  constructor() {
    super('Team not initialized. Run: agency team init --name "Your Team"');
    this.name = "TeamNotFoundError";
  }
}

export class TeamAlreadyExistsError extends Error {
  constructor() {
    super("Team config already exists at .agency/team.json");
    this.name = "TeamAlreadyExistsError";
  }
}

export class TeamMemberExistsError extends Error {
  constructor(id: string) {
    super(`Team member already exists: ${id}`);
    this.name = "TeamMemberExistsError";
  }
}

export class TeamMemberNotFoundError extends Error {
  constructor(id: string) {
    super(`Team member not found: ${id}`);
    this.name = "TeamMemberNotFoundError";
  }
}

export function teamConfigPath(projectRoot: string): string {
  return join(projectRoot, ".agency", "team.json");
}

export function initTeam(projectRoot: string, teamName: string): TeamConfig {
  const path = teamConfigPath(projectRoot);
  if (existsSync(path)) {
    throw new TeamAlreadyExistsError();
  }
  const config: TeamConfig = {
    version: 1,
    teamName,
    members: [],
    policies: { requireApprovalForDeploy: true },
  };
  saveTeam(projectRoot, config);
  return config;
}

export function loadTeam(projectRoot: string): TeamConfig | null {
  const path = teamConfigPath(projectRoot);
  if (!existsSync(path)) return null;
  const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
  return TeamConfigSchema.parse(raw);
}

export function saveTeam(projectRoot: string, config: TeamConfig): void {
  const validated = TeamConfigSchema.parse(config);
  const dir = join(projectRoot, ".agency");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    teamConfigPath(projectRoot),
    `${JSON.stringify(validated, null, 2)}\n`,
    "utf8"
  );
}

function requireTeam(projectRoot: string): TeamConfig {
  const config = loadTeam(projectRoot);
  if (!config) throw new TeamNotFoundError();
  return config;
}

export function addMember(projectRoot: string, member: TeamMember): TeamConfig {
  const config = requireTeam(projectRoot);
  if (config.members.some((m) => m.id === member.id)) {
    throw new TeamMemberExistsError(member.id);
  }
  const parsed = TeamMemberSchema.parse(member);
  const updated: TeamConfig = {
    ...config,
    members: [...config.members, parsed],
  };
  saveTeam(projectRoot, updated);
  return updated;
}

export function removeMember(projectRoot: string, id: string): TeamConfig {
  const config = requireTeam(projectRoot);
  if (!config.members.some((m) => m.id === id)) {
    throw new TeamMemberNotFoundError(id);
  }
  const updated: TeamConfig = {
    ...config,
    members: config.members.filter((m) => m.id !== id),
  };
  saveTeam(projectRoot, updated);
  return updated;
}
