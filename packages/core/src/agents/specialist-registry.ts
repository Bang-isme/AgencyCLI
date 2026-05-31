import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

export interface SpecialistProfile {
  id: string;
  name: string;
  role: string;
  systemPrompt: string;
  skills: string[];
  clearanceLevel: "LOW" | "MEDIUM" | "HIGH";
}

const BUILTIN_SPECIALISTS: Record<string, SpecialistProfile> = {
  architect: {
    id: "architect",
    name: "System Architect",
    role: "Designs core architecture patterns, workspace structures, and cross-package interfaces.",
    systemPrompt: "You are an expert System Architect. Focus on robust package isolation, low coupling, high cohesion, and scalable modular designs.",
    skills: ["codex-plan-writer", "codex-subagent-execution"],
    clearanceLevel: "HIGH",
  },
  coder: {
    id: "coder",
    name: "Software Engineer",
    role: "Implements software logic, functional features, and components across the codebase.",
    systemPrompt: "You are an expert Software Engineer. Implement clean, self-documenting code with clear error pathways and minimal runtime dependencies.",
    skills: ["codex-test-driven-development"],
    clearanceLevel: "MEDIUM",
  },
  tester: {
    id: "tester",
    name: "QA Automation Engineer",
    role: "Generates vitest unit tests, end-to-end integration tests, and quality gate check steps.",
    systemPrompt: "You are an expert Quality Assurance Engineer. Build extensive mock suites and verify 100% green test results under diverse failure scenarios.",
    skills: ["codex-test-driven-development"],
    clearanceLevel: "LOW",
  },
  "security-auditor": {
    id: "security-auditor",
    name: "Security Officer",
    role: "Performs AST audits, inspects sandbox boundaries, and assesses filesystem mutation risks.",
    systemPrompt: "You are an expert Security Officer. Analyze potential shell injections, directory traversal paths, and network egress vectors strictly.",
    skills: ["codex-security-specialist"],
    clearanceLevel: "HIGH",
  },
};

export class DomainSpecialistRegistry {
  private static instance: DomainSpecialistRegistry;
  private specialists: Map<string, SpecialistProfile> = new Map();

  private constructor() {
    this.loadBuiltins();
  }

  public static getInstance(): DomainSpecialistRegistry {
    if (!DomainSpecialistRegistry.instance) {
      DomainSpecialistRegistry.instance = new DomainSpecialistRegistry();
    }
    return DomainSpecialistRegistry.instance;
  }

  private loadBuiltins() {
    for (const [id, spec] of Object.entries(BUILTIN_SPECIALISTS)) {
      this.specialists.set(id, spec);
    }
  }

  /**
   * Registers a specialist profile in-memory.
   */
  public registerSpecialist(profile: SpecialistProfile): void {
    this.specialists.set(profile.id, profile);
  }

  /**
   * Lists all registered specialists, dynamically merging local workspace overrides
   * from .agency/specialists/*.json
   */
  public listSpecialists(projectRoot?: string): SpecialistProfile[] {
    const list = new Map(this.specialists);

    if (projectRoot) {
      const dir = join(projectRoot, ".agency", "specialists");
      if (existsSync(dir)) {
        try {
          const files = readdirSync(dir);
          for (const file of files) {
            if (file.endsWith(".json")) {
              const fullPath = join(dir, file);
              const data = JSON.parse(readFileSync(fullPath, "utf8")) as Partial<SpecialistProfile>;
              if (data.id) {
                list.set(data.id, {
                  id: data.id,
                  name: data.name ?? data.id,
                  role: data.role ?? "",
                  systemPrompt: data.systemPrompt ?? "",
                  skills: data.skills ?? [],
                  clearanceLevel: data.clearanceLevel ?? "LOW",
                });
              }
            }
          }
        } catch {
          // Robust swallow for file readdir/parse errors
        }
      }
    }

    return Array.from(list.values());
  }

  /**
   * Gets a specialist by ID, checking local workspace overrides if present.
   */
  public getSpecialist(id: string, projectRoot?: string): SpecialistProfile | null {
    if (projectRoot) {
      const overridePath = join(projectRoot, ".agency", "specialists", `${id}.json`);
      if (existsSync(overridePath)) {
        try {
          const data = JSON.parse(readFileSync(overridePath, "utf8")) as Partial<SpecialistProfile>;
          if (data.id === id) {
            return {
              id,
              name: data.name ?? id,
              role: data.role ?? "",
              systemPrompt: data.systemPrompt ?? "",
              skills: data.skills ?? [],
              clearanceLevel: data.clearanceLevel ?? "LOW",
            };
          }
        } catch {
          // Swallow and fall back
        }
      }
    }

    return this.specialists.get(id) ?? null;
  }
}
