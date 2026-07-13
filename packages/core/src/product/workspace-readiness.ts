import { existsSync } from "node:fs";
import { join } from "node:path";
import { loadAgencyConfig, resolveApiKey, type ProviderProfile } from "@agency/providers";
import { getGitSummary } from "../git/intelligence.js";
import { isIndexStale } from "../index/workspace-indexer.js";
import { resolveSkillsRoot } from "../skills-root.js";

export type ReadinessState = "ready" | "attention" | "optional";

export interface WorkspaceReadinessCheck {
  id: "provider" | "skills" | "index" | "git";
  state: ReadinessState;
  label: string;
  detail: string;
  recovery?: string;
}

/** Canonical usable-provider predicate for setup, doctor, status, and the TUI. */
export function providerIsUsable(id: string, profile?: ProviderProfile): boolean {
  return id === "local" || Boolean(resolveApiKey(profile)?.trim()) || (!profile?.apiKey && Boolean(profile?.baseUrl));
}

/** Shared, non-mutating readiness check for setup, doctor, CLI status and TUI status. */
export async function getWorkspaceReadiness(projectRoot: string): Promise<WorkspaceReadinessCheck[]> {
  let config: ReturnType<typeof loadAgencyConfig>;
  try {
    config = loadAgencyConfig();
  } catch {
    config = { defaultProvider: "openrouter", providers: {} } as ReturnType<typeof loadAgencyConfig>;
  }
  const readyProviders = Object.entries(config.providers ?? {}).filter(([id, profile]) =>
    providerIsUsable(id, profile)
  );

  let skillsReady = false;
  try {
    const root = resolveSkillsRoot();
    skillsReady = existsSync(join(root, ".system", "manifest.json"));
  } catch {
    skillsReady = false;
  }

  const git = await getGitSummary(projectRoot);
  return [
    readyProviders.length > 0
      ? { id: "provider", state: "ready", label: "Provider", detail: `${readyProviders.length} configured` }
      : { id: "provider", state: "attention", label: "Provider", detail: "No usable provider", recovery: "Open /connect or run agency config set." },
    skillsReady
      ? { id: "skills", state: "ready", label: "Skills", detail: "Skills pack available" }
      : { id: "skills", state: "attention", label: "Skills", detail: "Skills pack unavailable", recovery: "Set AGENCY_SKILLS_ROOT or reinstall the skills pack." },
    (() => {
      try { return isIndexStale(projectRoot); } catch { return true; }
    })()
      ? { id: "index", state: "attention", label: "File index", detail: "Needs refresh", recovery: "Run /index or agency setup." }
      : { id: "index", state: "ready", label: "File index", detail: "Up to date" },
    git.available
      ? { id: "git", state: "ready", label: "Git", detail: git.isClean ? `Clean · ${git.branch}` : `${git.staged + git.unstaged + git.untracked} change(s) · ${git.branch}` }
      : { id: "git", state: "optional", label: "Git", detail: "Not a repository", recovery: "Initialize Git to enable diff review." },
  ];
}
