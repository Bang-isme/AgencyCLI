import { cpSync, rmSync, existsSync, mkdirSync, readdirSync, statSync, readFileSync } from "node:fs";
import { join, relative, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { closeDb } from "@agency/memory";
import { loadIgnoreFilter, type IgnoreFilter } from "../index/gitignore-parser.js";

export interface WorkspaceIsolation {
  tempDir: string;
  projectRoot: string;
}

export interface WorkspaceChanges {
  createdOrModified: string[];
  deleted: string[];
}

function getAllFiles(dir: string, baseDir: string = dir, ignoreFilter?: IgnoreFilter): string[] {
  const files: string[] = [];
  if (!existsSync(dir)) return files;
  const list = readdirSync(dir);
  for (const file of list) {
    const filePath = join(dir, file);
    const stat = statSync(filePath);
    const relPath = relative(baseDir, filePath);
    const normalizedRelPath = relPath.replace(/\\/g, "/");

    if (ignoreFilter && ignoreFilter.isIgnored(normalizedRelPath, stat.isDirectory())) {
      continue;
    }

    if (stat.isDirectory()) {
      files.push(...getAllFiles(filePath, baseDir, ignoreFilter));
    } else {
      files.push(relPath);
    }
  }
  return files;
}

export function createIsolatedWorkspace(
  projectRoot: string,
  agentId: string
): WorkspaceIsolation {
  const uuid = randomUUID();
  const tempDir = join(tmpdir(), "agency-workspaces", `${agentId}-${uuid}`);
  mkdirSync(tempDir, { recursive: true });

  const ignoreFilter = loadIgnoreFilter(projectRoot);

  cpSync(projectRoot, tempDir, {
    recursive: true,
    filter: (srcPath) => {
      const rel = relative(projectRoot, srcPath);
      if (!rel) return true; // root itself
      const stat = statSync(srcPath);
      const normalizedRelPath = rel.replace(/\\/g, "/");
      return !ignoreFilter.isIgnored(normalizedRelPath, stat.isDirectory());
    },
  });

  return { tempDir, projectRoot };
}

export function detectWorkspaceChanges(ws: WorkspaceIsolation): WorkspaceChanges {
  const ignoreFilter = loadIgnoreFilter(ws.projectRoot);
  const tempFiles = getAllFiles(ws.tempDir, ws.tempDir, ignoreFilter);
  const origFiles = getAllFiles(ws.projectRoot, ws.projectRoot, ignoreFilter);


  const createdOrModified: string[] = [];
  const deleted: string[] = [];

  // Check for created or modified
  for (const file of tempFiles) {
    const origPath = join(ws.projectRoot, file);
    const tempPath = join(ws.tempDir, file);

    if (!existsSync(origPath)) {
      createdOrModified.push(file);
    } else {
      const origStat = statSync(origPath);
      const tempStat = statSync(tempPath);
      if (origStat.size !== tempStat.size) {
        createdOrModified.push(file);
      } else {
        const origContent = readFileSync(origPath);
        const tempContent = readFileSync(tempPath);
        if (!origContent.equals(tempContent)) {
          createdOrModified.push(file);
        }
      }
    }
  }

  // Check for deleted
  for (const file of origFiles) {
    const tempPath = join(ws.tempDir, file);
    if (!existsSync(tempPath)) {
      deleted.push(file);
    }
  }

  return { createdOrModified, deleted };
}

export interface MergeResult {
  success: boolean;
  mergedFiles: string[];
  deletedFiles: string[];
  conflicts: string[];
}

export function mergeWorkspaceChanges(
  workspaces: WorkspaceIsolation[],
  projectRoot: string
): MergeResult {
  const allChanges = workspaces.map((ws) => ({
    ws,
    changes: detectWorkspaceChanges(ws),
  }));

  const fileToWorkspace = new Map<string, string>();
  const conflicts = new Set<string>();

  // Check for overlapping changes across workspaces
  for (const { ws, changes } of allChanges) {
    const wsName = relative(projectRoot, ws.tempDir);
    const allFileChanges = [...changes.createdOrModified, ...changes.deleted];

    for (const file of allFileChanges) {
      if (fileToWorkspace.has(file)) {
        conflicts.add(file);
      } else {
        fileToWorkspace.set(file, wsName);
      }
    }
  }

  if (conflicts.size > 0) {
    return {
      success: false,
      mergedFiles: [],
      deletedFiles: [],
      conflicts: Array.from(conflicts),
    };
  }

  const mergedFiles: string[] = [];
  const deletedFiles: string[] = [];

  // If no conflicts, apply all changes
  for (const { ws, changes } of allChanges) {
    for (const file of changes.createdOrModified) {
      const src = join(ws.tempDir, file);
      const dest = join(projectRoot, file);
      mkdirSync(dirname(dest), { recursive: true });
      cpSync(src, dest, { recursive: true });
      mergedFiles.push(file);
    }

    for (const file of changes.deleted) {
      const dest = join(projectRoot, file);
      if (existsSync(dest)) {
        rmSync(dest, { force: true, recursive: true });
        deletedFiles.push(file);
      }
    }
  }

  return {
    success: true,
    mergedFiles,
    deletedFiles,
    conflicts: [],
  };
}

export function cleanIsolatedWorkspace(ws: WorkspaceIsolation): void {
  closeDb(ws.tempDir);
  if (existsSync(ws.tempDir)) {
    rmSync(ws.tempDir, { recursive: true, force: true });
  }
}
