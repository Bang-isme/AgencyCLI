import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Resolve relative development path to packages/cli/skills inside the monorepo.
 */
function devSkillsPath(): string | undefined {
  try {
    const currentDir = dirname(fileURLToPath(import.meta.url));
    
    // Check if we are running in the monorepo structure
    const localDevPath1 = join(currentDir, "../../cli/skills");
    if (existsSync(localDevPath1) && existsSync(join(localDevPath1, ".system/manifest.json"))) return localDevPath1;

    const localDevPath2 = join(currentDir, "../../../packages/cli/skills");
    if (existsSync(localDevPath2) && existsSync(join(localDevPath2, ".system/manifest.json"))) return localDevPath2;

    const localDevPath3 = join(currentDir, "../../packages/cli/skills");
    if (existsSync(localDevPath3) && existsSync(join(localDevPath3, ".system/manifest.json"))) return localDevPath3;
  } catch {
    // ignore
  }
  return undefined;
}

/**
 * Resolve the bundled skills path shipped inside @agency/cli package.
 * Uses ESM import.meta.resolve first, falls back to relative node_modules traversal.
 */
function bundledSkillsPath(): string | undefined {
  try {
    // Try to resolve using import.meta.resolve in ESM
    const cliEntryUrl = (import.meta as any).resolve
      ? (import.meta as any).resolve("@agency/cli")
      : undefined;
    if (cliEntryUrl) {
      const cliEntryPath = fileURLToPath(cliEntryUrl);
      const cliPkg = dirname(dirname(cliEntryPath)); // up from dist/index.js -> package root
      const bundled = join(cliPkg, "skills");
      if (existsSync(bundled)) return bundled;
    }
  } catch {
    // ignore
  }

  // Fallback to relative node_modules check
  try {
    const currentDir = dirname(fileURLToPath(import.meta.url));
    // Up from packages/core/dist/ to packages/core/node_modules/@agency/cli/skills
    const pathInNodeModules = join(currentDir, "../../../@agency/cli/skills");
    if (existsSync(pathInNodeModules)) return pathInNodeModules;
  } catch {
    // ignore
  }

  return undefined;
}

const CANDIDATES = [
  () => process.env.AGENCY_SKILLS_ROOT,
  // Monorepo development path (checks relative local path first)
  devSkillsPath,
  // Bundled skills shipped inside @agency/cli
  bundledSkillsPath,
  // Fallbacks in home folder
  () => join(homedir(), ".agency", "skills"),
  () => join(homedir(), ".cursor", "skills-cursor"),
  () => join(homedir(), ".codex", "skills"),
];

function hasManifest(root: string): boolean {
  return existsSync(join(root, ".system", "manifest.json"));
}

export function resolveSkillsRoot(): string {
  for (const pick of CANDIDATES) {
    const root = pick();
    if (root && hasManifest(root)) return root;
  }

  // Fallback: bootstrap default empty skills root in ~/.agency/skills
  const defaultRoot = join(homedir(), ".agency", "skills");
  const sysDir = join(defaultRoot, ".system");
  try {
    if (!existsSync(sysDir)) {
      mkdirSync(sysDir, { recursive: true });
    }
    const manifestPath = join(sysDir, "manifest.json");
    if (!existsSync(manifestPath)) {
      writeFileSync(manifestPath, JSON.stringify({ skills: [] }, null, 2));
    }
    return defaultRoot;
  } catch {
    throw new Error(
      "Agency skills pack not found. Set AGENCY_SKILLS_ROOT or bootstrap skills to ~/.agency/skills"
    );
  }
}
