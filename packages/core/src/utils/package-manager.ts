import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type PackageManager = "npm" | "yarn" | "pnpm" | "bun" | "unknown";

export interface BuildCommand {
  command: string;
  args: string[];
}

/**
 * Detect which package manager is being used in the project
 */
export function detectPackageManager(projectRoot: string): PackageManager {
  // Check for lock files in priority order
  if (existsSync(join(projectRoot, "bun.lockb")) || existsSync(join(projectRoot, "bun.lock"))) {
    return "bun";
  }
  if (existsSync(join(projectRoot, "pnpm-lock.yaml"))) {
    return "pnpm";
  }
  if (existsSync(join(projectRoot, "yarn.lock"))) {
    return "yarn";
  }
  if (existsSync(join(projectRoot, "package-lock.json"))) {
    return "npm";
  }
  
  // Check for package manager field in package.json
  const packageJsonPath = join(projectRoot, "package.json");
  if (existsSync(packageJsonPath)) {
    try {
      const { readFileSync } = require("node:fs");
      const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
      if (packageJson.packageManager) {
        if (packageJson.packageManager.startsWith("pnpm@")) return "pnpm";
        if (packageJson.packageManager.startsWith("yarn@")) return "yarn";
        if (packageJson.packageManager.startsWith("npm@")) return "npm";
        if (packageJson.packageManager.startsWith("bun@")) return "bun";
      }
    } catch {
      // Ignore errors reading package.json
    }
  }
  
  return "unknown";
}

/**
 * Get the build command for the detected package manager
 */
export function getBuildCommand(packageManager: PackageManager): BuildCommand {
  switch (packageManager) {
    case "pnpm":
      return { command: "pnpm", args: ["build"] };
    case "yarn":
      return { command: "yarn", args: ["build"] };
    case "bun":
      return { command: "bun", args: ["run", "build"] };
    case "npm":
    default:
      return { command: "npm", args: ["run", "build"] };
  }
}

/**
 * Get the test command for the detected package manager
 */
export function getTestCommand(packageManager: PackageManager): BuildCommand {
  switch (packageManager) {
    case "pnpm":
      return { command: "pnpm", args: ["test"] };
    case "yarn":
      return { command: "yarn", args: ["test"] };
    case "bun":
      return { command: "bun", args: ["test"] };
    case "npm":
    default:
      return { command: "npm", args: ["test"] };
  }
}

/**
 * Get the lint command for the detected package manager
 */
export function getLintCommand(packageManager: PackageManager): BuildCommand {
  switch (packageManager) {
    case "pnpm":
      return { command: "pnpm", args: ["lint"] };
    case "yarn":
      return { command: "yarn", args: ["lint"] };
    case "bun":
      return { command: "bun", args: ["run", "lint"] };
    case "npm":
    default:
      return { command: "npm", args: ["run", "lint"] };
  }
}

export interface AcceptanceOptions {
  /** Include `lint` when the project defines a lint script. */
  lint?: boolean;
  /** Include `test` when the project defines a non-placeholder test script. */
  test?: boolean;
}

function readPackageScripts(projectRoot: string): Record<string, string> {
  try {
    const pkg = JSON.parse(readFileSync(join(projectRoot, "package.json"), "utf8"));
    return pkg && typeof pkg.scripts === "object" && pkg.scripts ? pkg.scripts : {};
  } catch {
    return {};
  }
}

/**
 * Build the acceptance-criteria command set for the verify loop.
 *
 * Build is always included (preserves the pre-verify-loop behaviour — a single
 * `[[build]]` when no extras are requested). `lint`/`test` are added only when
 * the flag asks AND the project actually defines that script (so we never fail
 * verification on a command that doesn't exist), and the npm placeholder test
 * (`echo "Error: no test specified"`) is skipped. Returns an array of
 * argv-style command arrays for `StagingEngine.verifyTransaction`.
 */
export function buildAcceptanceCommands(
  projectRoot: string,
  opts: AcceptanceOptions = {}
): string[][] {
  const pm = detectPackageManager(projectRoot);
  const scripts = readPackageScripts(projectRoot);
  const toArgv = (c: BuildCommand): string[] => [c.command, ...c.args];

  const commands: string[][] = [toArgv(getBuildCommand(pm))];

  if (opts.lint && typeof scripts.lint === "string" && scripts.lint.trim() !== "") {
    commands.push(toArgv(getLintCommand(pm)));
  }
  if (opts.test && typeof scripts.test === "string") {
    const t = scripts.test.trim();
    const isPlaceholder = t === "" || /no test specified/i.test(t);
    if (!isPlaceholder) commands.push(toArgv(getTestCommand(pm)));
  }

  return commands;
}

/**
 * Strict acceptance set for the MAIN chat turn (arbitrary user projects).
 *
 * Unlike `buildAcceptanceCommands` (which always includes `build` — safe for the
 * subagent path that runs inside a known buildable workspace), this only emits a
 * command when the project actually defines that script. With no build/lint/test
 * script it returns `[]`, and the caller skips verification rather than failing a
 * plain chat turn on a `Missing script: build` error. `build` here requires an
 * explicit `scripts.build` (we don't guess a bare `tsc`).
 */
export function buildAcceptanceCommandsStrict(
  projectRoot: string,
  opts: AcceptanceOptions = {}
): string[][] {
  const pm = detectPackageManager(projectRoot);
  const scripts = readPackageScripts(projectRoot);
  const toArgv = (c: BuildCommand): string[] => [c.command, ...c.args];
  const has = (name: string) => typeof scripts[name] === "string" && scripts[name]!.trim() !== "";

  const commands: string[][] = [];
  if (has("build")) commands.push(toArgv(getBuildCommand(pm)));
  if (opts.lint && has("lint")) commands.push(toArgv(getLintCommand(pm)));
  if (opts.test && has("test") && !/no test specified/i.test(scripts.test!)) {
    commands.push(toArgv(getTestCommand(pm)));
  }
  return commands;
}

/**
 * Get the install command for the detected package manager
 */
export function getInstallCommand(packageManager: PackageManager): BuildCommand {
  switch (packageManager) {
    case "pnpm":
      return { command: "pnpm", args: ["install"] };
    case "yarn":
      return { command: "yarn", args: ["install"] };
    case "bun":
      return { command: "bun", args: ["install"] };
    case "npm":
    default:
      return { command: "npm", args: ["install"] };
  }
}
