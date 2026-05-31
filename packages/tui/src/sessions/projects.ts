import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join, basename, resolve } from "node:path";
import { homedir } from "node:os";

export interface ProjectEntry {
  path: string;
  name: string;
  lastOpened: number;
  sessionCount: number;
}

function registryPath(): string {
  return join(homedir(), ".agency", "projects.json");
}

export function loadProjects(): ProjectEntry[] {
  const p = registryPath();
  if (!existsSync(p)) return [];
  try {
    return JSON.parse(readFileSync(p, "utf8")) as ProjectEntry[];
  } catch {
    return [];
  }
}

export function saveProjects(projects: ProjectEntry[]): void {
  const dir = join(homedir(), ".agency");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(registryPath(), JSON.stringify(projects, null, 2), "utf8");
}

export function addProject(projectPath: string): void {
  const abs = resolve(projectPath);
  const projects = loadProjects();
  const existing = projects.find((p) => p.path === abs);
  if (existing) {
    existing.lastOpened = Date.now();
  } else {
    projects.push({
      path: abs,
      name: basename(abs),
      lastOpened: Date.now(),
      sessionCount: 0,
    });
  }
  // Sort by lastOpened descending
  projects.sort((a, b) => b.lastOpened - a.lastOpened);
  saveProjects(projects);
}

export function removeProject(projectPath: string): void {
  const abs = resolve(projectPath);
  const projects = loadProjects().filter((p) => p.path !== abs);
  saveProjects(projects);
}

export function isValidProject(dirPath: string): boolean {
  const abs = resolve(dirPath);
  // Has .git/ or .agency/ directory
  return existsSync(join(abs, ".git")) || existsSync(join(abs, ".agency"));
}

export function touchProject(projectPath: string, sessionCount?: number): void {
  const abs = resolve(projectPath);
  const projects = loadProjects();
  const existing = projects.find((p) => p.path === abs);
  if (existing) {
    existing.lastOpened = Date.now();
    if (sessionCount !== undefined) existing.sessionCount = sessionCount;
  } else {
    projects.push({
      path: abs,
      name: basename(abs),
      lastOpened: Date.now(),
      sessionCount: sessionCount ?? 0,
    });
  }
  projects.sort((a, b) => b.lastOpened - a.lastOpened);
  saveProjects(projects);
}
