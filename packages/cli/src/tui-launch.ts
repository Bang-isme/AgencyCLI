import { existsSync } from "node:fs";
import { basename, resolve } from "node:path";

/** Top-level Commander subcommands — not TUI project paths. */
const HEADLESS_COMMANDS = new Set([
  "doctor",
  "route",
  "chat",
  "index",
  "memory",
  "run",
  "skill",
  "task",
  "workflow",
  "plugin",
  "git",
  "browser",
  "compact",
  "agents",
  "graph",
  "routing",
  "team",
  "schedule",
  "setup",
  "config",
  "status",
  "handover",
  "help",
  "--help",
  "-h",
  "--version",
  "-V",
]);

export interface TuiLaunchPlan {
  launch: boolean;
  project?: string;
}

function isProjectPathArg(arg: string): boolean {
  if (arg.startsWith("-")) return false;
  if (arg.startsWith("$")) return false;
  if (HEADLESS_COMMANDS.has(arg)) return false;
  return true;
}

/**
 * Resolve whether argv should launch the TUI instead of headless subcommands.
 * `acg` always launches TUI; optional first arg is project root.
 */
export function resolveTuiLaunch(argv: string[]): TuiLaunchPlan {
  const args = argv.slice(2);
  const bin = basename(argv[1] ?? "").replace(/\.(js|cjs|mjs)$/i, "");
  const isAcg = bin === "acg" || process.env.AGENCY_TUI === "true";

  if (args.length === 0) {
    return { launch: true };
  }

  if (isAcg && args.length >= 1 && isProjectPathArg(args[0]!)) {
    return { launch: true, project: resolve(args[0]!) };
  }

  if (args.length === 1 && isProjectPathArg(args[0]!)) {
    return { launch: true, project: resolve(args[0]!) };
  }

  if (
    args.length === 2 &&
    args[0] === "--project-root" &&
    existsSync(resolve(args[1]!))
  ) {
    return { launch: true, project: resolve(args[1]!) };
  }

  return { launch: false };
}
