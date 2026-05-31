/**
 * Capability-driven agent registry (Swarm hardening, audit §5(C)).
 *
 * The pre-hardening dispatch path routed work by a hardcoded role string and
 * tracked nothing about an agent's health or load — so a capability mismatch
 * (e.g. dispatching `test-engineer` for an architecture task) went undetected,
 * and a repeatedly-failing or saturated agent kept receiving work.
 *
 * This module adds the missing runtime model:
 *   - a {@link AgentCapabilityDescriptor} per built-in agent (capabilities,
 *     clearance, live health + utilization),
 *   - {@link CapabilityAgentRegistry.rankForTask} to score agents against an
 *     inferred capability need,
 *   - {@link CapabilityAgentRegistry.recordOutcome} / `markInFlight` / `markDone`
 *     to keep health + utilization current from the dispatch finish/error paths.
 *
 * It is **opt-in**: dispatch only consults it when `AGENCY_CAPABILITY_ROUTING`
 * is on (off in legacy, on in hardened). With the flag off the registry is inert
 * and routing reproduces the legacy `coerceAgentId` behaviour exactly.
 */

import { MANIFEST_AGENTS, isAgentId, type AgentId } from "./types.js";

/** Numeric clearance ladder so descriptors can be compared/ordered. */
export const CLEARANCE_RANK = { LOW: 1, MEDIUM: 2, HIGH: 3 } as const;

export interface AgentHealth {
  successCount: number;
  failureCount: number;
  lastError?: string;
  /** ms epoch of the last time this agent started or finished work (0 = never). */
  lastSeen: number;
}

export interface AgentUtilization {
  currentTask: string | null;
  inFlight: number;
  maxConcurrent: number;
}

/** Capability + runtime descriptor for a dispatchable agent (audit §5(C)). */
export interface AgentCapabilityDescriptor {
  readonly id: AgentId;
  readonly role: string;
  /** Free-text capability tags matched against task needs. */
  readonly capabilities: readonly string[];
  /** 1=LOW, 2=MEDIUM, 3=HIGH. */
  readonly clearanceLevel: number;
  health: AgentHealth;
  utilization: AgentUtilization;
}

export interface TaskNeed {
  capabilities: string[];
  /** Minimum clearance the task requires (0 = any). */
  clearance: number;
}

export interface AgentRegistry {
  describe(id: AgentId): AgentCapabilityDescriptor | undefined;
  rankForTask(need: TaskNeed): AgentCapabilityDescriptor[];
  recordOutcome(id: AgentId, ok: boolean, error?: string): void;
}

/** Result of resolving the agent that should actually run a dispatch. */
export interface RouteResolution {
  agentId: AgentId;
  /** True when the registry steered away from the requested agent. */
  rerouted: boolean;
  /** Capabilities inferred from the task text (for observability). */
  matched: string[];
  reason: string;
}

interface AgentSeed {
  id: AgentId;
  role: string;
  capabilities: string[];
  clearanceLevel: number;
  maxConcurrent: number;
}

/**
 * Static capability profiles for the built-in manifest agents. Capability tags
 * are lowercase keywords matched (substring) against the task text. Kept here
 * (not in profiles.ts) so the routing model has a single source of truth.
 */
const AGENT_SEEDS: AgentSeed[] = [
  {
    id: "frontend-specialist",
    role: "Builds UI components, styling, and client-side behaviour.",
    capabilities: ["frontend", "ui", "react", "component", "css", "style", "layout", "browser", "tsx", "accessibility", "render"],
    clearanceLevel: CLEARANCE_RANK.MEDIUM,
    maxConcurrent: 2,
  },
  {
    id: "backend-specialist",
    role: "Implements APIs, services, persistence, and business logic.",
    capabilities: ["backend", "api", "server", "database", "endpoint", "sql", "schema", "auth", "service", "query", "migration", "logic"],
    clearanceLevel: CLEARANCE_RANK.MEDIUM,
    maxConcurrent: 2,
  },
  {
    id: "security-auditor",
    role: "Audits for vulnerabilities, sandbox escapes, and unsafe egress.",
    capabilities: ["security", "audit", "vulnerability", "injection", "sandbox", "traversal", "secret", "crypto", "permission", "exploit", "egress"],
    clearanceLevel: CLEARANCE_RANK.HIGH,
    maxConcurrent: 1,
  },
  {
    id: "debugger",
    role: "Diagnoses and fixes defects, crashes, and regressions.",
    capabilities: ["debug", "bug", "fix", "error", "crash", "stacktrace", "regression", "troubleshoot", "repro", "investigate", "failing"],
    clearanceLevel: CLEARANCE_RANK.MEDIUM,
    maxConcurrent: 2,
  },
  {
    id: "test-engineer",
    role: "Writes and maintains automated tests and quality gates.",
    capabilities: ["test", "testing", "vitest", "coverage", "unit", "integration", "qa", "assertion", "mock", "fixture", "e2e"],
    clearanceLevel: CLEARANCE_RANK.LOW,
    maxConcurrent: 3,
  },
  {
    id: "devops-engineer",
    role: "Owns CI/CD, packaging, infra, and release automation.",
    capabilities: ["devops", "ci", "cd", "deploy", "pipeline", "docker", "infra", "build", "release", "kubernetes", "container", "provision"],
    clearanceLevel: CLEARANCE_RANK.MEDIUM,
    maxConcurrent: 2,
  },
  {
    id: "planner",
    role: "Decomposes goals into architecture, specs, and task plans.",
    capabilities: ["plan", "design", "architecture", "roadmap", "breakdown", "spec", "requirement", "strategy", "decompose", "scope"],
    clearanceLevel: CLEARANCE_RANK.HIGH,
    maxConcurrent: 2,
  },
  {
    id: "scrum-master",
    role: "Coordinates multi-agent work and sprint orchestration.",
    capabilities: ["coordinate", "scrum", "sprint", "orchestrate", "manage", "delegate", "workflow", "standup", "backlog"],
    clearanceLevel: CLEARANCE_RANK.MEDIUM,
    maxConcurrent: 2,
  },
];

/** Union of every known capability keyword, used to tokenize a task. */
const ALL_CAPABILITIES: string[] = Array.from(
  new Set(AGENT_SEEDS.flatMap((s) => s.capabilities))
);

/**
 * Infers which capability tags a free-text task implies by substring match.
 * Returns a de-duplicated list (possibly empty when the task gives no signal).
 */
export function inferCapabilities(task: string): string[] {
  if (!task) return [];
  const haystack = task.toLowerCase();
  const matched = new Set<string>();
  for (const cap of ALL_CAPABILITIES) {
    if (haystack.includes(cap)) matched.add(cap);
  }
  return Array.from(matched);
}

function freshDescriptor(seed: AgentSeed): AgentCapabilityDescriptor {
  return {
    id: seed.id,
    role: seed.role,
    capabilities: [...seed.capabilities],
    clearanceLevel: seed.clearanceLevel,
    health: { successCount: 0, failureCount: 0, lastSeen: 0 },
    utilization: { currentTask: null, inFlight: 0, maxConcurrent: seed.maxConcurrent },
  };
}

/** Success ratio in [0,1]; an agent with no history is treated as healthy (1). */
function successRate(h: AgentHealth): number {
  const total = h.successCount + h.failureCount;
  return total === 0 ? 1 : h.successCount / total;
}

/** Count of a descriptor's capabilities present in the need set. */
function capabilityOverlap(desc: AgentCapabilityDescriptor, need: string[]): number {
  if (need.length === 0) return 0;
  const wanted = new Set(need);
  let n = 0;
  for (const cap of desc.capabilities) {
    if (wanted.has(cap)) n++;
  }
  return n;
}

export class CapabilityAgentRegistry implements AgentRegistry {
  private static instance: CapabilityAgentRegistry;
  private descriptors = new Map<string, AgentCapabilityDescriptor>();

  private constructor() {
    for (const seed of AGENT_SEEDS) {
      this.descriptors.set(seed.id, freshDescriptor(seed));
    }
  }

  public static getInstance(): CapabilityAgentRegistry {
    if (!CapabilityAgentRegistry.instance) {
      CapabilityAgentRegistry.instance = new CapabilityAgentRegistry();
    }
    return CapabilityAgentRegistry.instance;
  }

  /** Test/seed helper: restore the registry to its pristine built-in state. */
  public reset(): void {
    this.descriptors.clear();
    for (const seed of AGENT_SEEDS) {
      this.descriptors.set(seed.id, freshDescriptor(seed));
    }
  }

  public describe(id: AgentId): AgentCapabilityDescriptor | undefined {
    return this.descriptors.get(id);
  }

  /**
   * Ranks known agents for a task need. Score blends capability overlap (the
   * dominant term), historical success rate, and a penalty for current load so
   * a saturated or flaky agent loses to an idle healthy peer with equal skills.
   * Agents below the required clearance are excluded.
   */
  public rankForTask(need: TaskNeed): AgentCapabilityDescriptor[] {
    const eligible = Array.from(this.descriptors.values()).filter(
      (d) => d.clearanceLevel >= (need.clearance ?? 0)
    );
    const scored = eligible.map((d) => {
      const overlap = capabilityOverlap(d, need.capabilities);
      const utilizationPenalty =
        d.utilization.maxConcurrent > 0
          ? d.utilization.inFlight / d.utilization.maxConcurrent
          : 0;
      const score = overlap + successRate(d.health) - utilizationPenalty;
      return { d, overlap, score };
    });
    scored.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (b.overlap !== a.overlap) return b.overlap - a.overlap;
      if (a.d.health.failureCount !== b.d.health.failureCount) {
        return a.d.health.failureCount - b.d.health.failureCount;
      }
      return a.d.id < b.d.id ? -1 : a.d.id > b.d.id ? 1 : 0;
    });
    return scored.map((s) => s.d);
  }

  /** Records a completed dispatch outcome against an agent's health. */
  public recordOutcome(id: AgentId, ok: boolean, error?: string): void {
    const desc = this.descriptors.get(id);
    if (!desc) return;
    if (ok) desc.health.successCount++;
    else {
      desc.health.failureCount++;
      if (error) desc.health.lastError = error;
    }
    desc.health.lastSeen = Date.now();
  }

  /** Marks an agent as having started a unit of work (utilization up). */
  public markInFlight(id: AgentId, task: string): void {
    const desc = this.descriptors.get(id);
    if (!desc) return;
    desc.utilization.inFlight++;
    desc.utilization.currentTask = task;
    desc.health.lastSeen = Date.now();
  }

  /** Marks an agent as having finished a unit of work (utilization down). */
  public markDone(id: AgentId): void {
    const desc = this.descriptors.get(id);
    if (!desc) return;
    desc.utilization.inFlight = Math.max(0, desc.utilization.inFlight - 1);
    if (desc.utilization.inFlight === 0) desc.utilization.currentTask = null;
  }

  /**
   * Resolves which agent should actually run a dispatch.
   *
   * Conservative by design: it only steers away from the requested agent when
   * another known agent is a *strictly better* capability match for the task.
   * Custom (non-manifest) agents and tasks with no capability signal are left
   * untouched, so the change is observable but low-risk.
   */
  public resolveAgentForTask(input: {
    requested: AgentId;
    task: string;
    projectRoot?: string;
  }): RouteResolution {
    const { requested, task, projectRoot } = input;
    const matched = inferCapabilities(task);

    const requestedDesc = this.descriptors.get(requested);
    if (!requestedDesc) {
      // Unknown/custom agent — we have no capability model, keep as requested.
      return { agentId: requested, rerouted: false, matched, reason: "unmodeled-agent" };
    }
    if (matched.length === 0) {
      return { agentId: requested, rerouted: false, matched, reason: "no-capability-signal" };
    }

    const ranked = this.rankForTask({ capabilities: matched, clearance: 0 });
    const best = ranked[0];
    if (!best || best.id === requested) {
      return { agentId: requested, rerouted: false, matched, reason: "requested-is-best" };
    }

    const requestedOverlap = capabilityOverlap(requestedDesc, matched);
    const bestOverlap = capabilityOverlap(best, matched);
    // Only reroute on a strictly better capability fit, and never to an agent
    // the workspace doesn't recognize as dispatchable.
    if (bestOverlap > requestedOverlap && isAgentId(best.id, projectRoot)) {
      return {
        agentId: best.id,
        rerouted: true,
        matched,
        reason: `better-capability-match (${best.id}:${bestOverlap} > ${requested}:${requestedOverlap})`,
      };
    }
    return { agentId: requested, rerouted: false, matched, reason: "requested-sufficient" };
  }

  /** Serializable snapshot of all descriptors for `agency status`. */
  public snapshot(): AgentCapabilityDescriptor[] {
    return Array.from(this.descriptors.values()).map((d) => ({
      ...d,
      capabilities: [...d.capabilities],
      health: { ...d.health },
      utilization: { ...d.utilization },
    }));
  }
}

/** Shared singleton used by the dispatch path and `agency status`. */
export const capabilityRegistry = CapabilityAgentRegistry.getInstance();

/** Convenience accessor for the CLI/status layer. */
export function getAgentRegistrySnapshot(): AgentCapabilityDescriptor[] {
  return capabilityRegistry.snapshot();
}

export { MANIFEST_AGENTS };
