import { resolve } from "node:path";
import { getWorkspaceRoot } from "@agency/core";

/** Resolve CLI project root from `--project-root` or cwd (walks up to package.json). */
export function resolveProjectRoot(projectRoot?: string): string {
  const start = projectRoot ? resolve(projectRoot) : process.cwd();
  return getWorkspaceRoot(start);
}
