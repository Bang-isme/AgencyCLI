/**
 * Central runtime feature flags for the P0 hardening slice.
 *
 * Every behaviour change introduced by the production-hardening work is gated
 * here so it can be toggled per-environment without a code change, and so the
 * "legacy" profile can reproduce the pre-hardening behaviour exactly.
 *
 * Resolution order for each flag:
 *   1. explicit env override (AGENCY_*)   — always wins
 *   2. profile default (AGENCY_PROFILE)    — "legacy" | "hardened"
 *   3. built-in default
 *
 * See docs/PRODUCTION_AUDIT.md §6 (Migration Strategy, Principle 2).
 */

export type AgencyProfile = "legacy" | "hardened";
export type ApprovalToolPathMode = "off" | "warn" | "enforce";

export interface RuntimeFlags {
  profile: AgencyProfile;
  /** Mirror every EventBus publish into the durable SQLite journal. */
  persistEvents: boolean;
  /** On startup, scan for interrupted tasks and (optionally) resume them. */
  autoRecover: boolean;
  /** Gate write/destructive tools through the approval engine in the tool path. */
  approvalInToolPath: ApprovalToolPathMode;
  /** Enforce delegation depth / hop / cycle ceilings on agent dispatch. */
  delegationGuards: boolean;
  /** Max nesting depth for recursive agent delegation. */
  maxDepth: number;
  /** Max delegation chain length (hops). */
  maxHops: number;
  /** Max number of crash-resume attempts for a single task before escalating. */
  maxCrashLoops: number;
  /** Per-agent wall-clock deadline in ms (0 = disabled). Aborts a hung dispatch. */
  executionBudgetMs: number;
  /** Max agents running concurrently in a parallel dispatch. */
  maxParallelAgents: number;
  /** Run a memory GC/dedup/quota maintenance pass to bound store growth. */
  memoryGc: boolean;
  /** Hard ceiling on episode rows before quota eviction. */
  memoryMaxEpisodes: number;
  /** Hard ceiling on vector rows before quota eviction. */
  memoryMaxVectors: number;
  /** Timeout (ms) for a single MCP JSON-RPC request (0 = none). Prevents a hung server cascading. */
  mcpRequestTimeoutMs: number;
  /** Route dispatches by capability/health instead of the hardcoded requested role. */
  capabilityRouting: boolean;
  /** Reject a checkpoint whose checksum doesn't match (corrupt/tampered) instead of loading it. */
  checkpointStrict: boolean;
  /** Commit multi-file edits through a crash-surviving mutation journal (atomic rollback). */
  atomicRollback: boolean;
  /** Scan content on memory persist: redact secrets in episodes, quarantine secret-bearing vectors. */
  secretScan: boolean;
  /** Wrap a subagent edit attempt in an outer verify→self-correct loop (re-run on acceptance failure). */
  verifyLoop: boolean;
  /**
   * Also wrap the MAIN chat turn (not just subagent dispatches) in the verify
   * loop, so a direct "fix this" self-corrects too. Defaults to `verifyLoop`'s
   * resolved value; separate so the (build-on-every-edit) cost can be turned off
   * independently. Only the one-shot CLI path is wired today (not the interactive TUI).
   */
  verifyMainTurn: boolean;
  /** Max attempts in the verify loop (only used when verifyLoop is on). */
  verifyMaxRounds: number;
  /** Add `lint` to the verify-loop acceptance criteria (when the project has a lint script). */
  verifyLint: boolean;
  /** Add `test` to the verify-loop acceptance criteria (slow — opt-in; when a test script exists). */
  verifyTests: boolean;
  /** Use the bundled model catalog (models.json) for accurate per-model limits/cost/capabilities. */
  modelCatalog: boolean;
  /**
   * Proactively compact (summarize the middle of) a turn's conversation history
   * before it is sent to the model, once it exceeds ~70% of the context window,
   * so a long task doesn't overflow mid-conversation (roadmap §2.3). Off in
   * legacy (history sent verbatim — relies on the reactive context-limit retry),
   * on in hardened.
   */
  contextCompaction: boolean;
}

function parseBool(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined || raw === "") return fallback;
  const v = raw.trim().toLowerCase();
  if (["1", "true", "on", "yes", "y"].includes(v)) return true;
  if (["0", "false", "off", "no", "n"].includes(v)) return false;
  return fallback;
}

function parseInt10(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === "") return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function parseMode(
  raw: string | undefined,
  fallback: ApprovalToolPathMode
): ApprovalToolPathMode {
  if (raw === undefined || raw === "") return fallback;
  const v = raw.trim().toLowerCase();
  return v === "off" || v === "warn" || v === "enforce" ? v : fallback;
}

/**
 * Resolves the active runtime flags from `process.env`.
 *
 * This is intentionally not cached — flags are cheap to compute and reading
 * fresh keeps tests (which mutate env) deterministic.
 */
export function getRuntimeFlags(env: NodeJS.ProcessEnv = process.env): RuntimeFlags {
  const profile: AgencyProfile = env.AGENCY_PROFILE === "hardened" ? "hardened" : "legacy";
  const hardened = profile === "hardened";

  // Resolved first so verifyMainTurn can default to it.
  const verifyLoop = parseBool(env.AGENCY_VERIFY_LOOP, hardened);

  return {
    profile,
    // Additive + crash-safe: durable journaling is on by default in both profiles.
    persistEvents: parseBool(env.AGENCY_PERSIST_EVENTS, true),
    // Behaviour-changing: only auto-resume tasks under the hardened profile unless asked.
    autoRecover: parseBool(env.AGENCY_AUTO_RECOVER, hardened),
    // Non-blocking by default (warn); hardened enforces.
    approvalInToolPath: parseMode(env.AGENCY_APPROVAL_IN_TOOLPATH, hardened ? "enforce" : "warn"),
    // Purely protective with generous ceilings — on by default everywhere.
    delegationGuards: parseBool(env.AGENCY_DELEGATION_GUARDS, true),
    maxDepth: parseInt10(env.AGENCY_MAX_DEPTH, 8),
    maxHops: parseInt10(env.AGENCY_MAX_HOPS, 12),
    maxCrashLoops: parseInt10(env.AGENCY_MAX_CRASH_LOOPS, 3),
    // Wall-clock deadline changes behaviour (can abort a long legit run) → off in
    // legacy, 5min in hardened. parseInt10 floors at >0, so read raw for the 0 case.
    executionBudgetMs: (() => {
      const raw = env.AGENCY_EXECUTION_BUDGET_MS;
      if (raw === undefined || raw === "") return hardened ? 300_000 : 0;
      const n = parseInt(raw, 10);
      return Number.isFinite(n) && n >= 0 ? n : hardened ? 300_000 : 0;
    })(),
    maxParallelAgents: parseInt10(env.AGENCY_MAX_PARALLEL_AGENTS, 3),
    // Behaviour-changing (opens the memory DB at startup) → hardened-only default.
    memoryGc: parseBool(env.AGENCY_MEMORY_GC, hardened),
    memoryMaxEpisodes: parseInt10(env.AGENCY_MEMORY_MAX_EPISODES, 50_000),
    memoryMaxVectors: parseInt10(env.AGENCY_MEMORY_MAX_VECTORS, 50_000),
    // Purely protective (a hung server should always time out) → on by default everywhere.
    mcpRequestTimeoutMs: parseInt10(env.AGENCY_MCP_REQUEST_TIMEOUT_MS, 30_000),
    // Behaviour-changing (can re-route a dispatch away from the requested agent)
    // → off in legacy, on in hardened. Falls back to legacy role routing when off.
    capabilityRouting: parseBool(env.AGENCY_CAPABILITY_ROUTING, hardened),
    // Behaviour-changing (a checksum mismatch would otherwise still load) → legacy
    // warns and loads (preserves behaviour); hardened rejects the corrupt checkpoint.
    checkpointStrict: parseBool(env.AGENCY_CHECKPOINT_STRICT, hardened),
    // Behaviour-changing (journaled commit + startup rollback recovery) → off in
    // legacy (best-effort commit preserved), on in hardened.
    atomicRollback: parseBool(env.AGENCY_ATOMIC_ROLLBACK, hardened),
    // Behaviour-changing (redacts/quarantines on persist; could drop a false
    // positive) → off in legacy, on in hardened.
    secretScan: parseBool(env.AGENCY_SECRET_SCAN, hardened),
    // Behaviour-changing (re-runs the LLM on verify failure → more cost/time but
    // self-correcting) → off in legacy (single attempt), on in hardened.
    verifyLoop,
    // New hot-path behaviour (runs acceptance after edits on a plain chat turn) →
    // defaults to verifyLoop but independently switchable via its own env.
    verifyMainTurn: parseBool(env.AGENCY_VERIFY_MAIN_TURN, verifyLoop),
    verifyMaxRounds: parseInt10(env.AGENCY_VERIFY_MAX_ROUNDS, 3),
    // Lint is cheap → on in hardened; the full test suite is expensive → opt-in
    // everywhere (off by default even in hardened).
    verifyLint: parseBool(env.AGENCY_VERIFY_LINT, hardened),
    verifyTests: parseBool(env.AGENCY_VERIFY_TESTS, false),
    // Additive accuracy (better limits/cost/caps for any BYOK model) → on in
    // hardened; off in legacy to preserve the exact current spec resolution.
    modelCatalog: parseBool(env.AGENCY_MODEL_CATALOG, hardened),
    // Behaviour-changing (rewrites the prompt history with a summary; costs one
    // extra summarisation call when it triggers) → off in legacy (verbatim
    // history), on in hardened.
    contextCompaction: parseBool(env.AGENCY_CONTEXT_COMPACTION, hardened),
  };
}
