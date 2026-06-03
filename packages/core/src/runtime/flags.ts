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
  /**
   * Semantic memory recall: embed episodes (local deterministic embedder) on
   * persist and recall via the HybridRetriever (vector + FTS reciprocal-rank
   * fusion + recency). Off → keyword FTS + recency only (the legacy path).
   */
  memorySemantic: boolean;
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
   * independently. Wired into both the one-shot CLI (`runChatTurnWithVerify`) and
   * the interactive TUI (which resets the live buffer + surfaces each self-heal
   * round on the `chat:self-healing` event so the re-run is visible).
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
  /**
   * Record a per-session {@link DeterministicExecutionTrace} (turn timings +
   * tool I/O) to `.agency/traces/` for behaviour-level replay regression
   * (roadmap §2.5). Opt-in in both profiles — recording adds a per-tool push.
   */
  traceRecord: boolean;
  /**
   * Emit structured RuntimeThoughtEvents (`thought:emitted`) at runtime decision
   * points (routing, safety gating) so the TUI CognitionPanel — which already
   * subscribes to `thought:emitted` but had no live producer — narrates what the
   * agent is doing. Off in legacy (no extra bus events → byte-identical), on in
   * hardened. Gated centrally in `emitThought`, so call sites stay unconditional.
   */
  cognitionStream: boolean;
  /**
   * Order the system prompt STATIC-prefix-first (identity + protocol + tool
   * docs), then the session-stable goal anchor, then the per-turn variable tail
   * (route intent, context pack, memories, user question). A stable prefix lets
   * every OpenAI-compatible provider (NVIDIA / openrouter / deepseek / Ollama,
   * …) hit its automatic prefix cache — a large input-token saving on long
   * conversations. Off in legacy (variable-first order preserved byte-identical
   * — no prefix cache), on in hardened. Roadmap §8.11-B.
   */
  promptCachePrefix: boolean;
  /**
   * Soften the system prompt's "MUST outline exactly 5 approaches every turn"
   * rule to a complexity-scaled "a few (2–3), or a single clear recommendation
   * for simple tasks". Off in legacy (the exact-5 rule preserved verbatim), on
   * in hardened. Saves output tokens (pricier than input) + less formulaic on
   * easy tasks while keeping multi-option depth for hard ones. Roadmap §8.11-C.
   */
  softApproaches: boolean;
  /**
   * When a turn exhausts its tool/continuation loop (maxLoops) with possibly
   * unfinished work (e.g. a large file written in chunks via append_file), fold
   * a structured resume notice into the returned assistant text — a single
   * `[SYSTEM:]` line instructing a "continue" to read the current on-disk state
   * and append from where it stopped (never rewrite from scratch), plus a list
   * of every file the turn modified with its current size. The legacy notice was
   * a generic "response truncated" line that was never folded into the returned
   * text, so the NEXT turn's history had no record of it and a "continue"
   * restarted the file from scratch. On by default in both profiles (churn-cluster
   * correctness fix); set AGENCY_RESUME_CONTINUATION=0 to restore the legacy
   * generic, never-persisted truncation notice. Roadmap §8.10 (loop/resume
   * robustness).
   */
  resumeContinuation: boolean;
  /**
   * Render the built-in tool docs in the system prompt compactly — one
   * `Args: \`a\`, \`b?\`` line per tool listing arg names (with `?` for optional
   * and a type suffix only when it isn't the default string) — instead of a
   * verbose `- \`<a>\`: Parameter of type string.` line per arg. The system
   * prompt is sent every turn, and the per-arg "Parameter of type string."
   * boilerplate (~1109 tokens of tool docs total) is pure waste — the model only
   * needs the arg names + which are optional + non-string types. MCP tool docs
   * (which carry per-arg descriptions) stay verbose. Off in legacy (verbose docs
   * preserved byte-identical), on in hardened. Roadmap §8.11-D.
   */
  compactToolDocs: boolean;
  /**
   * Curated cross-session markdown memory (`.agency/memory/`): inject the agent's
   * saved memories into the prompt's `### SYSTEM HISTORICAL MEMORIES` block
   * (index + relevant topic bodies; `user`/`feedback` always surfaced as standing
   * instructions) AND advertise + enable the `remember` tool so the agent can
   * deliberately save durable facts (preferences, decisions, "don't re-investigate"
   * findings) as human-readable markdown — distinct from the automatic, opaque
   * SQLite episodic store. Off in legacy (no markdown recall, `remember` not
   * advertised → byte-identical prompt), on in hardened.
   */
  fileMemory: boolean;
  /**
   * Auto-continue a turn when the model stops emitting tool calls but explicitly
   * signalled the work is UNFINISHED — an end-of-message "I'll continue…"
   * promise, a "to be continued" marker, or a left-in "…rest of the code"
   * placeholder. Instead of returning a half-done turn (the user then has to
   * notice and type "continue"), feed a bounded resume nudge and run another loop
   * iteration (capped at MAX_AUTO_CONTINUE, still within maxLoops). On by default
   * in both profiles (churn-cluster correctness fix); set AGENCY_AUTO_CONTINUE=0 to
   * restore the legacy behaviour where a no-tool-call turn ends the loop. Roadmap
   * §2.2 / §8 completion detection.
   */
  autoContinue: boolean;
  /**
   * Reassemble a tool call that the output-token limit split across
   * length-continuations. A large `write_file` whose content exceeds one
   * response is cut off before its closing `</tool_call>` tag; `parseToolCalls`
   * needs that tag, so the call is dropped and the write never happens — the
   * model then sees the file as missing/"corrupted", rewrites it (truncating
   * again), and churns to the loop limit. When on, the turn loop carries the
   * partial tool-call XML forward and parses the combined buffer once the model
   * finishes it on the next completion, so the write executes exactly once. On by
   * default in both profiles (churn-cluster correctness fix); set
   * AGENCY_TOOLCALL_REASSEMBLY=0 to restore the legacy latest-completion-only parse.
   * Roadmap §8.10 (large-file write robustness).
   */
  toolCallReassembly: boolean;
  /**
   * When a tool result exceeds the size cap, keep BOTH a head and a tail window
   * for command-style output (`execute_command`) whose actionable part —
   * compiler errors, test failures, the exit summary — lands at the END. The
   * legacy cap kept only the head, so a verbose build that overflowed showed the
   * model its progress logs plus a "truncated" note but dropped the real errors
   * at the bottom (stderr + the tail of stdout): the model saw a non-zero exit it
   * couldn't explain and churned. On by default in both profiles (churn-cluster
   * correctness fix); set AGENCY_TOOLRESULT_TAIL=0 to restore the legacy head-only
   * truncation. Other tools (read_file, grep) stay head-only regardless — their
   * head is what was asked for and read_file ranges fetch more.
   */
  toolResultTailKept: boolean;
  /**
   * Confine the mutating file tools (write/append/edit/batch_edit/ast_edit/
   * delete/move/create_directory) to the project root: a `path` that resolves
   * outside projectRoot (via `../` traversal or an absolute path) is refused
   * instead of writing/deleting wherever it points. The tools resolve with
   * `resolve(projectRoot, path)` but never checked the result stayed inside, and
   * the RiskAssessor has no traversal rule, so a confused or prompt-injected
   * model could write or delete outside the workspace. Off in legacy (no
   * confinement — byte-identical; an agent that legitimately edits sibling paths
   * keeps working), on in hardened. Read tools are intentionally NOT confined
   * (lower risk + would block legitimately reading a referenced file).
   */
  pathConfinement: boolean;
  /**
   * Bound the WIDTH of concurrent subagent dispatch. The chat turn loop runs all
   * tool calls in a completion via `Promise.all`, so several `dispatch_subagent`
   * calls spawn full subagents concurrently on the same project root with no
   * ceiling — the delegation guards bound recursion depth/hops/cycles, not fan-out
   * breadth — risking a cost/resource runaway and concurrent edits racing on the
   * same files. When on, a shared semaphore limits in-flight `dispatchAgent` calls
   * (across the runtime AND the CLI parallel path) to `maxParallelAgents`; the
   * excess queue and run as slots free. A single dispatch is unaffected. Off in
   * legacy (uncapped `Promise.all`, byte-identical), on in hardened. Mirrors the
   * cap `dispatchAgentsParallel` already applies to the CLI path.
   */
  subagentConcurrencyCap: boolean;
  /**
   * Cursor-aware prompt composer. The legacy composer was append-only — typed
   * and pasted text could only be edited from the end (Backspace), the caret was
   * pinned to the buffer end, and there was no undo. When on, the composer tracks
   * a caret position: Left/Right (and Ctrl+←/→ word) navigation, Ctrl+A/Ctrl+E
   * to line start/end, insert and Delete/Backspace at the caret, Ctrl+W delete
   * word, and Ctrl+Z / Ctrl+Y undo/redo. On by default in both profiles (the
   * append-only composer left Left/Right doing nothing, so a typo earlier in the
   * line was unreachable — user-reported). The caret stays end-equivalent for the
   * only previously-reachable state (typing at the end), so existing flows are
   * byte-identical; only mid-buffer editing is new. Opt out with
   * AGENCY_COMPOSER_CURSOR=0 to restore append-only input.
   */
  composerCursorEdit: boolean;
  /**
   * Activate a workflow's declared skill chain when that workflow is selected.
   * Each `.workflows/<name>.md` declares `loads: [skill, …]` — the pipeline the
   * skill-pack author intended that workflow to run (e.g. `plan` →
   * intent-context-analyzer + plan-writer + workflow-autopilot + reasoning-rigor).
   * Nothing read that field: the router only activated its own hardcoded `skills`
   * (often a strict subset, e.g. `plan` → just `codex-plan-writer`), so a selected
   * workflow never ran its full declared pipeline (built-but-unwired). When on,
   * `routeUserPrompt` merges the workflow's `loads:` into the route's skills
   * (deduped, after the explicit/router skills so those keep priority) so the
   * workflow's SKILL.md chain is injected into the context pack. It ALSO surfaces
   * the workflow's process: the context pack gets an absolute-path hint to the
   * `.workflows/<name>.md` (step outline + exit criteria) that lives outside the
   * workspace, so codex-workflow-autopilot's "load the corresponding workflow
   * file" instruction is actually reachable (read_file resolves against the
   * project root, so the relative path would otherwise miss). Off in legacy (only
   * the router's skills load, no workflow hint → byte-identical prompt), on in
   * hardened. The context pack is char-budgeted, so the extra content can't overflow.
   */
  workflowSkillLoads: boolean;
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
    // Behaviour-changing (writes vectors on persist + changes recall ranking)
    // → off in legacy (keyword FTS + recency only), on in hardened.
    memorySemantic: parseBool(env.AGENCY_MEMORY_SEMANTIC, hardened),
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
    // Behaviour-recording for §2.5 replay regression; per-tool overhead → opt-in
    // (off by default even in hardened, like verifyTests).
    traceRecord: parseBool(env.AGENCY_TRACE_RECORD, false),
    // Observability narration for the (already-subscribed) cognition panel; emits
    // extra `thought:emitted` bus events → off in legacy, on in hardened.
    cognitionStream: parseBool(env.AGENCY_COGNITION_STREAM, hardened),
    // Behaviour-changing (reorders the system prompt so the static prefix is
    // stable across turns → enables provider-side prefix caching) → off in
    // legacy (variable-first order preserved byte-identical), on in hardened.
    promptCachePrefix: parseBool(env.AGENCY_PROMPT_CACHE, hardened),
    // Behaviour-changing (relaxes the "exactly 5 approaches" output rule) → off
    // in legacy (rule preserved verbatim), on in hardened.
    softApproaches: parseBool(env.AGENCY_SOFT_APPROACHES, hardened),
    // Churn-cluster correctness fix → on by default in BOTH profiles: a "continue"
    // after loop exhaustion must see the on-disk state, not restart from scratch.
    // Opt out with AGENCY_RESUME_CONTINUATION=0 to restore the legacy generic,
    // never-persisted truncation notice.
    resumeContinuation: parseBool(env.AGENCY_RESUME_CONTINUATION, true),
    // Behaviour-changing (shortens the per-turn tool docs → fewer prompt tokens)
    // → off in legacy (verbose docs byte-identical), on in hardened.
    compactToolDocs: parseBool(env.AGENCY_COMPACT_TOOL_DOCS, hardened),
    // Behaviour-changing (injects curated markdown memory into the prompt +
    // advertises the `remember` tool) → off in legacy (no markdown recall, tool
    // not advertised → byte-identical), on in hardened.
    fileMemory: parseBool(env.AGENCY_FILE_MEMORY, hardened),
    // Churn-cluster correctness fix → on by default in BOTH profiles: a turn that
    // explicitly signalled unfinished work continues instead of stranding the user
    // on a half-done result. Bounded by MAX_AUTO_CONTINUE within maxLoops. Opt out
    // with AGENCY_AUTO_CONTINUE=0 to restore the legacy turn-ends-immediately path.
    autoContinue: parseBool(env.AGENCY_AUTO_CONTINUE, true),
    // Churn-cluster correctness fix → on by default in BOTH profiles: a write split
    // across token-limit continuations is rejoined and executes once instead of
    // being dropped (→ no "file corrupted, rewrite from scratch" churn). Opt out
    // with AGENCY_TOOLCALL_REASSEMBLY=0 to restore the legacy latest-completion parse.
    toolCallReassembly: parseBool(env.AGENCY_TOOLCALL_REASSEMBLY, true),
    // Churn-cluster correctness fix → on by default in BOTH profiles: an overflowing
    // command result keeps its trailing compiler/test errors + exit summary so the
    // model isn't blind to why a build failed. Opt out with AGENCY_TOOLRESULT_TAIL=0
    // to restore the legacy head-only truncation. Other tools stay head-only.
    toolResultTailKept: parseBool(env.AGENCY_TOOLRESULT_TAIL, true),
    // Behaviour-changing (refuses a write/delete whose path escapes projectRoot)
    // → off in legacy (no confinement, byte-identical), on in hardened.
    pathConfinement: parseBool(env.AGENCY_PATH_CONFINEMENT, hardened),
    // Behaviour-changing (concurrent subagent dispatches queue at maxParallelAgents
    // instead of all running at once) → off in legacy (uncapped Promise.all,
    // byte-identical), on in hardened. Purely protective; single dispatch unaffected.
    subagentConcurrencyCap: parseBool(env.AGENCY_SUBAGENT_CONCURRENCY_CAP, hardened),
    // UX-correctness fix → on by default in BOTH profiles: the legacy append-only
    // composer could not edit mid-buffer at all — Left/Right did nothing, so a typo
    // earlier in the line was unreachable (user-reported). Typing at the end is
    // byte-identical (the caret is end-pinned until you move it), so existing flows
    // are unchanged; only mid-buffer caret nav / insert / delete / undo is newly
    // enabled. Opt out with AGENCY_COMPOSER_CURSOR=0 to restore append-only input.
    composerCursorEdit: parseBool(env.AGENCY_COMPOSER_CURSOR, true),
    // Behaviour-changing (a selected workflow activates its full declared skill
    // chain → more SKILL.md in the context pack, more tokens) → off in legacy (only
    // the router's own skills load, byte-identical), on in hardened.
    workflowSkillLoads: parseBool(env.AGENCY_WORKFLOW_SKILL_LOADS, hardened),
  };
}
