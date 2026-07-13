/**
 * Product-facing capability catalog & registry.
 * This is independent of Ink and Commander: every surface consumes the same labels,
 * tier, risk, prerequisites, and recovery guidance instead of maintaining duplicate lists.
 */

export type CapabilityTier = "core" | "advanced";
export type CapabilitySurface = "tui" | "cli" | "tool";
export type CapabilityRisk = "low" | "medium" | "high" | "critical";
export type CapabilityCategory =
  | "workspace"
  | "session"
  | "review"
  | "runtime"
  | "extension"
  | "automation"
  | "security"
  | "tool";

export interface CapabilityPrerequisite {
  /** Unique identifier for the prerequisite (e.g. "git_repo", "provider_configured") */
  id: string;
  /** Human-readable label or explanation */
  description: string;
  /** Optional evaluator function checking if prerequisite is satisfied */
  check?: (projectRoot: string) => boolean | Promise<boolean>;
}

export interface CapabilityDescriptor {
  /** Unique capability ID (e.g., "connect", "read_file", "chat", "compact") */
  id: string;
  /** Classification tier: 'core' for primary daily commands, 'advanced' for specialized features */
  tier: CapabilityTier;
  /** Human-friendly title (e.g., "Connect Provider", "Read File") */
  label: string;
  /** Concise description of capability purpose */
  description: string;
  /** Grouping category for UI sectioning and help menus */
  category: CapabilityCategory;
  /** Array of supported surfaces: 'tui', 'cli', and/or 'tool' */
  surfaces: CapabilitySurface[];
  /** Risk assessment level governing execution policy and user approval requirement */
  risk: CapabilityRisk;
  /** Array of prerequisite requirements that must be met before execution */
  prerequisites: (string | CapabilityPrerequisite)[];
  /** Actionable guidance or command to run if capability fails or is unconfigured */
  recoveryAction?: string;
  /** Backwards compatible alias for recoveryAction */
  recovery?: string;
  /** Visual symbol / icon for UI menus (e.g., "◆", "▣", "⊞") */
  icon?: string;
  /** Alternative command names / aliases (e.g., ["h"] for help, ["clear"] for new) */
  aliases?: string[];
}

export interface CapabilityFilterOptions {
  surface?: CapabilitySurface;
  tier?: CapabilityTier;
  category?: CapabilityCategory;
  maxRisk?: CapabilityRisk;
  query?: string;
}

export interface PrerequisiteCheckResult {
  satisfied: boolean;
  missing: string[];
}

export class CapabilityRegistry {
  private readonly capabilities = new Map<string, CapabilityDescriptor>();
  private readonly aliasMap = new Map<string, string>();

  constructor(initialCapabilities: readonly CapabilityDescriptor[] = []) {
    for (const cap of initialCapabilities) {
      this.register(cap);
    }
  }

  /** Registers a capability descriptor into the registry. Overwrites existing descriptor with same ID. */
  /** Registers a capability descriptor into the registry. Overwrites existing descriptor with same ID. */
  public register(descriptor: CapabilityDescriptor): void {
    const normalized: CapabilityDescriptor = {
      ...descriptor,
      recovery: descriptor.recoveryAction ?? descriptor.recovery,
      recoveryAction: descriptor.recoveryAction ?? descriptor.recovery,
      prerequisites: descriptor.prerequisites ?? [],
      risk: descriptor.risk ?? "low",
    };

    // Clean up previous alias mappings for the descriptor ID before registering new aliases
    const existing = this.capabilities.get(normalized.id);
    if (existing?.aliases) {
      for (const alias of existing.aliases) {
        const lower = alias.toLowerCase();
        if (this.aliasMap.get(lower) === normalized.id) {
          this.aliasMap.delete(lower);
        }
      }
    }
    for (const [alias, targetId] of this.aliasMap.entries()) {
      if (targetId === normalized.id) {
        this.aliasMap.delete(alias);
      }
    }

    this.capabilities.set(normalized.id, normalized);
    if (normalized.aliases) {
      for (const alias of normalized.aliases) {
        this.aliasMap.set(alias.toLowerCase(), normalized.id);
      }
    }
  }

  /** Unregisters a capability by ID or alias. */
  public unregister(idOrAlias: string): boolean {
    const canonicalId = this.resolveId(idOrAlias);
    if (!canonicalId || !this.capabilities.has(canonicalId)) {
      return false;
    }
    const cap = this.capabilities.get(canonicalId)!;
    if (cap.aliases) {
      for (const alias of cap.aliases) {
        const lower = alias.toLowerCase();
        if (this.aliasMap.get(lower) === canonicalId) {
          this.aliasMap.delete(lower);
        }
      }
    }
    for (const [alias, targetId] of this.aliasMap.entries()) {
      if (targetId === canonicalId) {
        this.aliasMap.delete(alias);
      }
    }
    return this.capabilities.delete(canonicalId);
  }

  /** Resolves an alias or ID to the canonical capability ID. */
  public resolveId(idOrAlias: string): string | undefined {
    const lower = idOrAlias.toLowerCase();
    if (this.capabilities.has(lower)) return lower;
    return this.aliasMap.get(lower);
  }

  /** Retrieves a descriptor by ID or alias. */
  public get(idOrAlias: string): CapabilityDescriptor | undefined {
    const canonicalId = this.resolveId(idOrAlias);
    return canonicalId ? this.capabilities.get(canonicalId) : undefined;
  }

  /** Checks if a capability is registered. */
  public has(idOrAlias: string): boolean {
    return this.resolveId(idOrAlias) !== undefined;
  }

  /** Lists capabilities matching filter criteria. */
  public list(options: CapabilityFilterOptions = {}): CapabilityDescriptor[] {
    let result = Array.from(this.capabilities.values());

    if (options.surface) {
      result = result.filter((c) => (c.surfaces ?? []).includes(options.surface!));
    }
    if (options.tier) {
      result = result.filter((c) => c.tier === options.tier);
    }
    if (options.category) {
      result = result.filter((c) => c.category === options.category);
    }
    if (options.maxRisk) {
      const riskRanks: Record<CapabilityRisk, number> = { low: 1, medium: 2, high: 3, critical: 4 };
      const maxRank = riskRanks[options.maxRisk];
      result = result.filter((c) => riskRanks[c.risk] <= maxRank);
    }
    if (options.query) {
      const q = options.query.toLowerCase();
      result = result.filter(
        (c) =>
          c.id.toLowerCase().includes(q) ||
          c.label.toLowerCase().includes(q) ||
          c.description.toLowerCase().includes(q) ||
          c.aliases?.some((a) => a.toLowerCase().includes(q))
      );
    }

    return result;
  }

  /** Evaluates prerequisites for a given capability. */
  public async checkPrerequisites(
    idOrAlias: string,
    projectRoot: string
  ): Promise<PrerequisiteCheckResult> {
    const cap = this.get(idOrAlias);
    if (!cap) {
      return { satisfied: false, missing: [`Capability "${idOrAlias}" not found`] };
    }

    const missing: string[] = [];
    for (const prereq of cap.prerequisites) {
      if (typeof prereq === "string") {
        const ok = await this.evaluateBuiltinPrereq(prereq, projectRoot);
        if (!ok) missing.push(prereq);
      } else {
        if (prereq.check) {
          try {
            const ok = await prereq.check(projectRoot);
            if (!ok) missing.push(prereq.id);
          } catch {
            missing.push(prereq.id);
          }
        }
      }
    }

    return { satisfied: missing.length === 0, missing };
  }

  /** Bridges an @agency/tooling ToolDefinition into a CapabilityDescriptor. */
  public registerToolDefinition(
    name: string,
    description: string,
    category: CapabilityCategory = "tool",
    risk: CapabilityRisk = "low",
    recoveryAction?: string
  ): CapabilityDescriptor {
    const descriptor: CapabilityDescriptor = {
      id: name,
      tier: category === "workspace" || name.startsWith("read_") ? "core" : "advanced",
      label: name.replace(/_/g, " ").replace(/\b\w/g, (l) => l.toUpperCase()),
      description,
      category,
      surfaces: ["tool"],
      risk,
      prerequisites: [],
      recoveryAction,
      recovery: recoveryAction,
      icon: "⚙",
    };
    this.register(descriptor);
    return descriptor;
  }

  private async evaluateBuiltinPrereq(prereq: string, projectRoot: string): Promise<boolean> {
    switch (prereq) {
      case "git_repo": {
        try {
          const { existsSync } = await import("node:fs");
          const { join } = await import("node:path");
          return existsSync(join(projectRoot, ".git"));
        } catch {
          return false;
        }
      }
      case "provider_configured": {
        try {
          const { loadAgencyConfig } = await import("@agency/providers");
          const cfg = loadAgencyConfig();
          return Boolean(cfg.defaultProvider && cfg.providers[cfg.defaultProvider]);
        } catch {
          return false;
        }
      }
      default:
        return true;
    }
  }
}

/** Master Seed Catalog for all capabilities */
export const MASTER_CAPABILITIES: readonly CapabilityDescriptor[] = [
  // Workspace & Core TUI/CLI capabilities
  { id: "help", tier: "core", surfaces: ["tui", "cli"], label: "Help", description: "Shortcuts and capability discovery overlay", category: "workspace", risk: "low", prerequisites: [], icon: "?", aliases: ["h"] },
  { id: "setup", tier: "core", surfaces: ["tui", "cli"], label: "Setup wizard", description: "Initial workspace setup & onboarding wizard", category: "workspace", risk: "low", prerequisites: [], icon: "⚙" },
  { id: "doctor", tier: "core", surfaces: ["tui", "cli"], label: "System doctor", description: "Inspect provider, environment, and runtime health", category: "runtime", risk: "low", prerequisites: [], icon: "🩺" },
  { id: "connect", tier: "core", surfaces: ["tui", "cli"], label: "Connect provider", description: "Set up API keys and providers", category: "workspace", risk: "low", prerequisites: [], recoveryAction: "Run /connect to add a usable provider.", recovery: "Run /connect to add a usable provider.", icon: "◆" },
  { id: "models", tier: "core", surfaces: ["tui", "cli"], label: "Choose model", description: "Select an available model", category: "workspace", risk: "low", prerequisites: ["provider_configured"], recoveryAction: "Run /connect first to configure a provider.", recovery: "Run /connect first to configure a provider.", icon: "▣", aliases: ["model"] },
  { id: "sessions", tier: "core", surfaces: ["tui", "cli"], label: "Sessions manager", description: "Resume, fork, export, or delete sessions", category: "session", risk: "low", prerequisites: [], icon: "↺", aliases: ["session", "resume", "continue"] },
  { id: "new", tier: "core", surfaces: ["tui", "cli"], label: "New session", description: "Start a clean conversation", category: "session", risk: "low", prerequisites: [], icon: "+", aliases: ["clear"] },
  { id: "export", tier: "core", surfaces: ["tui", "cli"], label: "Export session", description: "Write current session to Markdown", category: "session", risk: "low", prerequisites: [], recoveryAction: "Exported to .agency/sessions/", recovery: "Exported to .agency/sessions/", icon: "↗", aliases: ["x"] },
  { id: "project", tier: "core", surfaces: ["tui", "cli"], label: "Switch project", description: "Switch the active workspace", category: "workspace", risk: "low", prerequisites: [], icon: "◈" },
  { id: "review", tier: "core", surfaces: ["tui", "cli"], label: "Review changes", description: "Inspect working tree, commit, branch, or CI", category: "review", risk: "medium", prerequisites: ["git_repo"], recoveryAction: "Ensure the project is a Git repository.", recovery: "Ensure the project is a Git repository.", icon: "△" },
  { id: "status", tier: "core", surfaces: ["tui", "cli"], label: "Workspace status", description: "Provider, context, index, and runtime health", category: "runtime", risk: "low", prerequisites: [], icon: "◎", aliases: ["viewstatus"] },
  { id: "index", tier: "core", surfaces: ["tui", "cli"], label: "Refresh file index", description: "Update @file search for this workspace", category: "workspace", risk: "low", prerequisites: [], recoveryAction: "Run agency index --force", recovery: "Run agency index --force", icon: "⊞" },
  { id: "compact", tier: "core", surfaces: ["tui", "cli"], label: "Compact context", description: "Reduce conversation context safely", category: "session", risk: "medium", prerequisites: [], recoveryAction: "Use /compact dry to preview", recovery: "Use /compact dry to preview", icon: "⊟" },
  { id: "exit", tier: "core", surfaces: ["tui"], label: "Exit application", description: "Leave the interactive workspace", category: "workspace", risk: "low", prerequisites: [], icon: "×", aliases: ["quit", "q"] },

  // Advanced capabilities
  { id: "skills", tier: "advanced", surfaces: ["tui", "cli"], label: "Skills picker", description: "Browse and inject installed skills", category: "extension", risk: "medium", prerequisites: [], recoveryAction: "Install skills in ~/.cursor/skills", recovery: "Install skills in ~/.cursor/skills", icon: "◇", aliases: ["skill"] },
  { id: "plugin", tier: "advanced", surfaces: ["tui", "cli"], label: "Plugins manager", description: "Inspect installed skills packs", category: "extension", risk: "medium", prerequisites: [], recoveryAction: "Inspect plugins with agency plugin list", recovery: "Inspect plugins with agency plugin list", icon: "p", aliases: ["plugins"] },
  { id: "mcp", tier: "advanced", surfaces: ["tui", "cli"], label: "MCP servers", description: "Configure external tool servers", category: "extension", risk: "high", prerequisites: [], recoveryAction: "Configure servers in ~/.agency/mcp.json", recovery: "Configure servers in ~/.agency/mcp.json", icon: "⊡" },
  { id: "theme", tier: "advanced", surfaces: ["tui"], label: "Switch theme", description: "Change terminal appearance", category: "workspace", risk: "low", prerequisites: [], recoveryAction: "Available themes: agency, daylight", recovery: "Available themes: agency, daylight", icon: "◐", aliases: ["themes"] },
  { id: "variant", tier: "advanced", surfaces: ["tui", "cli"], label: "Reasoning budget", description: "Configure model reasoning budget", category: "runtime", risk: "low", prerequisites: ["provider_configured"], recoveryAction: "Choose supported thinking model", recovery: "Choose supported thinking model", icon: "v" },
  { id: "goal", tier: "advanced", surfaces: ["tui", "cli"], label: "Goal runner", description: "Run a long autonomous task", category: "automation", risk: "high", prerequisites: ["provider_configured"], recoveryAction: "Check goal task parameters", recovery: "Check goal task parameters", icon: "⊕" },
  { id: "team", tier: "advanced", surfaces: ["tui", "cli"], label: "Team dispatch", description: "Manage subagent team dispatch and multi-agent coordination", category: "runtime", risk: "high", prerequisites: [], icon: "👥" },
  { id: "tasks", tier: "advanced", surfaces: ["tui", "cli"], label: "Tasks manager", description: "Manage plan and background tasks", category: "automation", risk: "low", prerequisites: [], icon: "☐", aliases: ["task"] },
  { id: "workflow", tier: "advanced", surfaces: ["tui", "cli"], label: "Workflows", description: "Execute structured workflow packs and pipelines", category: "automation", risk: "medium", prerequisites: [], icon: "🔄" },
  { id: "schedule", tier: "advanced", surfaces: ["tui", "cli"], label: "Task schedule", description: "Create recurring tasks", category: "automation", risk: "medium", prerequisites: [], recoveryAction: "Format: /schedule every 30m task", recovery: "Format: /schedule every 30m task", icon: "◷" },
  { id: "agents", tier: "advanced", surfaces: ["tui", "cli"], label: "Subagents inspector", description: "Inspect delegated work", category: "runtime", risk: "medium", prerequisites: [], icon: "⊞" },
  { id: "route", tier: "advanced", surfaces: ["tui", "cli"], label: "Routing preview", description: "Preview and correct prompt routing", category: "runtime", risk: "low", prerequisites: [], recoveryAction: "Use /route feedback <intent>", recovery: "Use /route feedback <intent>", icon: "→", aliases: ["routing"] },
  { id: "dashboard", tier: "advanced", surfaces: ["tui", "cli"], label: "Knowledge dashboard", description: "Open memory and graph dashboard", category: "runtime", risk: "low", prerequisites: [], recoveryAction: "Run /index to build dashboard HTML", recovery: "Run /index to build dashboard HTML", icon: "▤", aliases: ["memory", "graph"] },
  { id: "browser", tier: "advanced", surfaces: ["tui", "cli"], label: "Browser tool", description: "Launch headless browser for scraping & search", category: "tool", risk: "medium", prerequisites: [], icon: "🌐" },
  { id: "replay", tier: "advanced", surfaces: ["cli"], label: "Replay session", description: "Replay session transcripts or test regression suite", category: "runtime", risk: "low", prerequisites: [], icon: "▶", aliases: ["replay-regression"] },
  { id: "eval", tier: "advanced", surfaces: ["cli"], label: "Evaluate model", description: "Evaluate prompt outputs and model benchmark gates", category: "runtime", risk: "low", prerequisites: [], icon: "📊" },
  { id: "benchmark", tier: "advanced", surfaces: ["cli"], label: "Run benchmark", description: "Execute benchmark test suites evaluating model quality", category: "runtime", risk: "low", prerequisites: [], icon: "📈" },
  { id: "server", tier: "advanced", surfaces: ["cli"], label: "Server daemon", description: "Launch background Agency API server daemon", category: "runtime", risk: "medium", prerequisites: [], icon: "🖥" },
  { id: "handover", tier: "advanced", surfaces: ["tui", "cli"], label: "Handover report", description: "Generate 5-component handoff report for team handover", category: "workspace", risk: "low", prerequisites: [], icon: "📋" },
  { id: "git", tier: "advanced", surfaces: ["cli"], label: "Git tools", description: "Standalone CLI git operations helper", category: "review", risk: "medium", prerequisites: ["git_repo"], icon: "🔀" },

  // Tools
  { id: "read_file", tier: "core", surfaces: ["tool"], label: "Read file", description: "Read workspace content", category: "tool", risk: "low", prerequisites: [], recoveryAction: "Ensure path exists and is readable.", recovery: "Ensure path exists and is readable.", icon: "⚙" },
  { id: "write_file", tier: "core", surfaces: ["tool"], label: "Write file", description: "Create or replace workspace content", category: "tool", risk: "high", prerequisites: [], recoveryAction: "Check write permissions.", recovery: "Check write permissions.", icon: "⚙" },
  { id: "edit_file", tier: "core", surfaces: ["tool"], label: "Edit file", description: "Apply a targeted workspace edit", category: "tool", risk: "medium", prerequisites: [], recoveryAction: "Target file must exist.", recovery: "Target file must exist.", icon: "⚙" },
  { id: "execute_command", tier: "core", surfaces: ["tool", "cli"], label: "Run command", description: "Run a sandboxed shell command", category: "runtime", risk: "critical", prerequisites: [], recoveryAction: "Inspect command security policy.", recovery: "Inspect command security policy.", icon: "⚙" },
  { id: "git_summary", tier: "core", surfaces: ["tool"], label: "Git summary", description: "Inspect workspace changes", category: "review", risk: "low", prerequisites: ["git_repo"], icon: "⚙" },
  { id: "git_diff", tier: "core", surfaces: ["tool"], label: "Git diff", description: "Inspect textual changes", category: "review", risk: "low", prerequisites: ["git_repo"], icon: "⚙" },
  { id: "dispatch_subagent", tier: "advanced", surfaces: ["tool"], label: "Delegate task", description: "Run one scoped specialist task", category: "runtime", risk: "medium", prerequisites: [], icon: "⚙" },
  { id: "dispatch_parallel", tier: "advanced", surfaces: ["tool"], label: "Delegate in parallel", description: "Run independent specialist tasks", category: "runtime", risk: "high", prerequisites: [], icon: "⚙" },
];

/** Global singleton registry instance */
export const capabilityRegistry = new CapabilityRegistry(MASTER_CAPABILITIES);

/** Backward-compatible array export backed by the registry */
export const CAPABILITIES: readonly CapabilityDescriptor[] = new Proxy([], {
  get(_target, prop) {
    const list = capabilityRegistry.list();
    if (prop === "length") return list.length;
    if (typeof prop === "symbol") return (list as any)[prop];
    if (!isNaN(Number(prop))) return list[Number(prop)];
    const val = (list as any)[prop];
    return typeof val === "function" ? val.bind(list) : val;
  },
});

export function listCapabilities(surface?: CapabilitySurface, tier?: CapabilityTier): CapabilityDescriptor[] {
  return capabilityRegistry.list({ surface, tier });
}

export function findCapability(id: string): CapabilityDescriptor | undefined {
  return capabilityRegistry.get(id);
}

/** A safe fallback lets third-party/MCP tools participate without copying tool lists. */
export function describeToolCapability(name: string, category = "other"): Pick<CapabilityDescriptor, "label" | "description" | "category" | "tier"> {
  const cap = capabilityRegistry.get(name);
  if (cap) {
    return {
      label: cap.label,
      description: cap.description,
      category: cap.category,
      tier: cap.tier,
    };
  }
  return {
    label: name.replace(/_/g, " "),
    description: `Run ${name}`,
    category: (category === "workspace" || category === "session" || category === "review" || category === "runtime" || category === "extension" || category === "automation" || category === "security" || category === "tool") ? category : "runtime",
    tier: category === "read" ? "core" : "advanced",
  };
}

