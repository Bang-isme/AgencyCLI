import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export function getWorkspaceRoot(start: string): string {
  let dir = resolve(start);
  while (dir !== dirname(dir)) {
    if (existsSync(join(dir, "package.json"))) return dir;
    dir = dirname(dir);
  }
  return resolve(start);
}
