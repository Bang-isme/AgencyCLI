import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface TuiConfig {
  theme?: string;
  leader?: string;
  goalRunnerViewMode?: "flat" | "boxy";
}

export function loadTuiConfig(projectRoot?: string): TuiConfig {
  const paths = [
    projectRoot ? join(projectRoot, ".agency", "tui.json") : null,
    projectRoot ? join(projectRoot, ".codex", "tui.json") : null,
    join(homedir(), ".agency", "tui.json"),
    join(homedir(), ".codex", "tui.json"),
  ].filter((p): p is string => Boolean(p));

  for (const path of paths) {
    if (!existsSync(path)) continue;
    try {
      return JSON.parse(readFileSync(path, "utf8")) as TuiConfig;
    } catch {
      return {};
    }
  }
  return {};
}

export function saveTuiConfig(cfg: TuiConfig): void {
  const path = join(homedir(), ".agency", "tui.json");
  try {
    writeFileSync(path, JSON.stringify(cfg, null, 2), "utf8");
  } catch {
    // ignore
  }
}
