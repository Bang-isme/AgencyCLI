# AgencyCLI Production-Readiness Audit — Cross-Cutting Synthesis

> Generated from the `agencycli-production-audit` multi-agent workflow (8 subsystem auditors reading real code + 1 synthesizer). Per-subsystem detail with `file:line` evidence is in [PRODUCTION_AUDIT_APPENDIX.md](PRODUCTION_AUDIT_APPENDIX.md).

## 1. Executive Verdict

**Overall maturity: PARTIAL across all 8 subsystems — not yet fit for unattended multi-week autonomous operation.**

Every subsystem audited rates "partial." The codebase has impressive *mechanism depth* (lock managers, staging engines, CRDT mergers, convergence scoring, circuit breakers, risk assessors) but a recurring structural defect: **the safety machinery exists but is not wired into the live execution path.** Components are built, unit-tested, exported — and then never instantiated in production. This is the single most dangerous pattern in the audit, because it produces a false sense of safety: the code *looks* hardened in review, but the guardrails are inert at runtime.

The stated goal is to "operate autonomously for weeks while remaining recoverable, observable, and debuggable." Five things most directly threaten that goal:

1. **No durable event sourcing at runtime (CRITICAL).** The EventBus publishes ~20 event types to an in-memory journal capped at 10k events, but `EventJournal.appendEvent()` is *never called in production* — the SQLite journal is test-only (Event Sourcing audit: "EventBus publishes to in-memory journal only... Process crash = all events lost"). A process crash mid-run erases the entire execution history. You cannot reconstruct what an agent did, cannot replay, cannot debug a failure that happened overnight. This breaks "observable" and "debuggable" outright.

2. **No automatic crash recovery on startup (CRITICAL).** Checkpoints are durably written with fsync, but nothing reads them on restart. `EventJournal.readEvents()` is never called at bootstrap; `RecoverySupervisor.verifyAndRestore()` is "only called in tests"; resumption requires a human to type `task resume <id>` (Recovery audit). An autonomous agent that crashes at 3am stays dead until a human intervenes — the opposite of "operate for weeks while recoverable."

3. **Unbounded recursive/cyclic agent delegation (CRITICAL).** There is no `max_depth`, no `max_hops`, no circular-delegation detection. `AGENCY_AGENT_ID` is set in the environment but never checked; `dispatch_subagent` accepts any agentId with zero validation (Swarm audit). Agent A can dispatch B which dispatches A, forever, each iteration burning budget and spawning processes. The only loop detection is per-inference-turn and cannot see across dispatch boundaries.

4. **Approval gates are bypassed by the actual tool path (CRITICAL).** The `ApprovalPolicyEngine` is "NEVER called in the tool execution path" (Tool audit). Approval only fires inside `runShellCommand()`. So `delete_file`, `move_file`, and *every MCP tool* (Slack send, S3 delete, GitHub repo create) execute with no human gate, no risk assessment, no sandbox. An autonomous agent with MCP connectors is an unbounded blast radius.

5. **No memory bounds or garbage collection (HIGH).** The 4-layer memory abstraction is entirely absent — everything lands in undifferentiated SQLite tables with no row caps, no GC scheduler, no deduplication, no decay (Memory audit). `decay_factor` and `confidence_score` fields exist but are never updated. Over weeks, tables grow without bound, retrieval quality degrades as duplicates and stale low-confidence noise accumulate, and secrets can be persisted because `detectSecrets()` only runs on ingestion input, not on `addEpisode()`.

The throughline: **AgencyCLI is event-*aware* but not event-*sourced*; recovery-*capable* but not recovery-*automatic*; governance-*designed* but not governance-*enforced*.** Closing the wiring gaps (not building new mechanisms) is the bulk of the P0 work.

---

## 2. Cross-Cutting Gap Matrix

Merged across subsystems; sorted by priority then effort (S < M < L < XL).

| Gap | Subsystem(s) | Priority | Effort | Why it blocks production |
|---|---|---|---|---|
| No `max_depth` enforcement for recursive agent delegation | Swarm | P0 | S | Unbounded recursion burns budget + spawns processes until OOM; runaway with no ceiling |
| No circular-delegation detection (A→B→A) | Swarm | P0 | S | Infinite delegation cycle; `AGENCY_AGENT_ID` set but never checked |
| `RecoverySupervisor.verifyAndRestore()` not called in prod (only tests); no DB integrity check on startup | Recovery, Memory | P0 | S | Corrupt SQLite opens silently; memory state never validated after crash |
| EventBus does not persist events to EventJournal at runtime | Event Sourcing | P0 | M | Process crash loses all history; not observable, not debuggable, not replayable |
| No automatic startup recovery bootstrap; restart does not detect/resume incomplete work | Recovery | P0 | M | Agent stays dead after crash until human runs `task resume`; defeats "operate for weeks" |
| Event journal never read for state rebuild on startup | Event Sourcing, Recovery | P0 | M | State cannot be reconstructed; replay verification absent at runtime |
| ApprovalPolicyEngine not integrated into tool execution flow | Tool/Approval | P0 | M | `delete_file`/`move_file`/destructive tools execute with no gate; engine is dead code in this path |
| MCP tools bypass approval, sandbox, and governance entirely | Tool/Approval | P0 | L | Slack/S3/GitHub MCP tools run with `z.record(z.any())` schema, no human gate — unbounded external blast radius |
| Tool registry errors propagate uncaught; can crash runtime | Tool/Approval | P0 | M | Unhandled `execute()` exception crashes CLI; violates "tool failures must never crash runtime" |
| Missing 7 of 12 task states (CREATED, PLANNING, READY, BLOCKED, WAITING_APPROVAL, REVIEWING, CANCELLED) | Task Graph | P0 | M | State machine can't model approval-waiting or blocked work; observability gaps |
| No file-level mutual exclusion for concurrent task writes (second write wins) | Task Graph, Swarm | P0 | L | Parallel agents corrupt overlapping files; rollback only reverts last writer |
| No 4-tier context budget; no protection that Critical (active task/plan/approvals/code mods) survives pressure | Context Engine | P0 | L | Budget pressure silently drops pending approvals and recent edits; agent loses its own state |
| No semantic tier classification; approval state not preserved across repack | Context Engine | P0 | M | Approval requests silently evicted on budget repack — agent forgets it was waiting for a human |
| No 4-layer memory abstraction (Working/Session/Project/Knowledge) | Memory | P0 | XL | No scoping, no layer TTL, no tiering — root cause of unbounded growth and pollution |
| No unified CLI to inspect agents/task-graph/memory/context/metrics | Observability | P0 | L | Cannot see what a long-running autonomous agent is doing; not observable |
| Artifact system lacks artifact_id/owner/version/timestamp | Observability | P0 | M | Outputs not addressable, versionable, or auditable; no provenance |
| In-memory EventBus journal lost on crash; no recovery bootstrapping | Event Sourcing | P0 | L | Even with persistence, cache not warmed from disk on restart |
| No `max_hops` enforcement (delegation chain length) | Swarm | P1 | S | Long delegation chains accumulate cost/latency with no ceiling |
| Secret detection not enforced on all persisted memory | Memory | P1 | S | API keys/tokens persisted to disk in episodes/vectors; compliance + leak risk |
| No execution_budget/time_budget deadline per agent | Swarm | P1 | M | Hung worker runs indefinitely; only OS/memory-cap kills it |
| Cost budget not protected against concurrent dispatch overspend | Swarm | P1 | M | 3 parallel agents call `recordSpend` without mutex; budget ceiling overshoot |
| No agent-level loop detection across dispatch boundaries | Swarm | P1 | M | Coordinator blind to cross-agent loops; per-turn detector insufficient |
| Worker process crash not detected; lease timeout is only mitigation (up to 5s latency) | Recovery, Task Graph | P1 | M | Subagent segfault → task hangs until lease expires |
| Concurrent checkpoint saves lack synchronization (last write wins) | Task Graph | P1 | M | Parallel tasks clobber checkpoint; corrupt resume state |
| Circular DAG dependencies detected only at runtime deadlock | Task Graph | P1 | M | No static cycle check; deadlock surfaces deep into execution |
| Rollback is best-effort with per-file error swallowing; no atomic multi-file rollback | Recovery | P1 | L | Partial rollback leaves codebase broken; "continue other rollbacks" on I/O error |
| Mutation graph truncated under memory pressure → cannot rollback beyond window | Recovery, Task Graph | P1 | M | History discarded; deep rollback impossible |
| No automated GC / scheduled eviction of stale/low-confidence memory | Memory | P1 | L | Tables grow unbounded over weeks; retrieval polluted |
| No deduplication of memory entries | Memory | P1 | M | Duplicate ingestion inflates indices, degrades retrieval latency |
| No memory quota per tenant/type/layer | Memory | P1 | M | Disk/heap exhaustion on long runs |
| No MemoryAgent ownership / Orchestrator approval gate for persistence | Memory | P1 | L | Any module writes memory directly; no provenance, no gate |
| Agent health/utilization not tracked; no capability-driven routing | Swarm | P1 | L | Hardcoded role routing; capability mismatch (test-engineer for architecture) undetected |
| ContextEscalationEngine defined but never wired to runtime | Context Engine | P1 | M | 5-tier escalation dead code; no fallback to Critical-only on token-limit error |
| No read-only context enforcement for workers/subagents | Context Engine | P1 | M | Workers receive mutable context; no immutability boundary |
| Event schema incomplete (no agent_id/task_id/cost/duration) | Event Sourcing | P1 | M | Cannot attribute cost/time per agent/task; weak forensics |
| MCP client has no JSON-RPC request timeout | Tool/Approval | P1 | M | Hung MCP server accumulates pending requests forever |
| Health checks not periodic; no global monitor for tools/MCP/plugins | Tool/Approval, Observability | P1 | L | Degraded tool/MCP undetected during long runs |
| Package-install commands not gated for approval | Tool/Approval | P1 | S | Arbitrary dependency install with no human sign-off |
| No session_summary.md / handover.md generation | Event Sourcing | P1 | M | No milestone summaries or resume handover; weak debuggability/continuity |
| Checkpoint format not versioned; no validation on load | Recovery, Observability | P1 | M | Schema drift breaks resume; corrupt state loads silently |
| No write-isolation on DagTaskNode state (direct mutation bypasses state machine) | Task Graph, Observability | P1 | M | Convention-only enforcement; illegal state can persist |
| Decay factor / confidence score never updated; aging inert | Memory | P2 | M | Stale memory ranked equally to fresh; quality erodes |
| FIFO lock queue allows starvation; no priority scheduling | Swarm, Task Graph | P2 | M | Low-priority agent times out repeatedly under contention |
| Parallelism limit hardcoded to 3; not configurable | Swarm | P2 | S | Cannot tune throughput vs. resource pressure |
| Configurable max_retry_count (currently hardcoded 3) | Swarm | P2 | S | Cannot tune retry budget per task |
| Merge conflicts on parallel writes not auto-resolved; no rollback of partial merges | Swarm | P2 | L | Conflict returns error but leaves successful merges applied |
| Recovery strategy exhaustion without fallback (human-escalation) | Recovery, Task Graph | P2 | M | Diminishing-weight strategies retry indefinitely between 0.6–0.8 stagnation |
| No event throughput / failure-rate metrics | Observability | P2 | S | No SLO signal for long-run health |
| No tool health/success metrics | Observability | P2 | M | Cannot see which tools fail repeatedly |
| Artifact versioning/rollback for patches/outputs absent | Observability | P2 | L | Only memory mutations auditable; output artifacts untracked |
| Compression not wired in (crude truncation only) | Context Engine, Memory | P2 | M | Context loss instead of semantic compaction |

---

## 3. Failure-Mode Rollup

Critical and high failure modes grouped by theme, with blast radius.

### Theme A — State Loss (the "amnesia" cluster)
- **No event persistence to disk (CRITICAL, Event Sourcing).** EventJournal never instantiated; in-memory journal trimmed at 10k. *Blast radius:* total loss of execution history on crash — no forensics, no replay, no resume. Affects every subsystem because events are the substrate for observability.
- **Process crash → checkpoint exists but not auto-loaded (CRITICAL, Recovery).** *Blast radius:* in-flight task graph stalls indefinitely until human runs `task resume`; the entire autonomous run halts on any crash.
- **Task checkpoint loss/corruption (CRITICAL, Observability).** Kill between `dagState` assignment and `saveCheckpointRobust()`; no checksum on read. *Blast radius:* resume loads garbage or fails; whole plan unrecoverable.
- **Approval state lost under budget pressure (HIGH, Context Engine).** *Blast radius:* agent forgets it was waiting for human approval, may silently proceed or stall — both dangerous.
- **Concurrent checkpoint saves: last write wins (Task Graph).** *Blast radius:* parallel tasks clobber each other's checkpoint; resume sees partial graph.

### Theme B — Runaway Execution (the "unbounded" cluster)
- **Infinite recursive/cyclic agent delegation (CRITICAL, Swarm).** No depth/hops/cycle checks. *Blast radius:* exponential process spawn + cost burn until OOM or budget ceiling (if even reached, given the concurrent-overspend bug). Can take down the host.
- **Stagnation loop / infinite retry oscillation (CRITICAL, Task Graph).** Entropy-decay strategy weights may miss effective strategies; stagnation 0.6–0.8 retries indefinitely. *Blast radius:* a single failing task consumes the whole run's budget.
- **Cost budget bypass via concurrent dispatch (HIGH, Swarm).** `recordSpend` without mutex across 3 parallel agents. *Blast radius:* budget ceiling overshoot — the one hard financial guardrail leaks.
- **Unbounded worker memory growth (HIGH, Swarm).** 512MB cap is arbitrary, applies only to registered processes. *Blast radius:* host memory exhaustion from a leaked worker.
- **Event queue overflow / backpressure ignored (HIGH, Observability).** Callers don't check `publish()` return. *Blast radius:* LOW-priority events silently shed; observability gaps precisely when the system is busiest.

### Theme C — Memory Pollution (the "rot" cluster)
- **Unbounded table growth (HIGH, Memory).** No eviction, no quota. *Blast radius:* disk/heap exhaustion over weeks; the explicit "operate for weeks" target is where this detonates.
- **Layer-boundary violations — no 4-layer model (HIGH, Memory).** *Blast radius:* no isolation between ephemeral working memory and durable knowledge; transient noise pollutes long-term retrieval permanently.
- **Secret stored in memory content (CRITICAL, Memory).** `detectSecrets()` not enforced on `addEpisode()`/`insertVector()`. *Blast radius:* API keys persisted to disk in plaintext; leak + compliance exposure that survives the session.
- **Concurrent non-serialized writes corrupt (HIGH, Memory).** Nothing forces use of WriteQueue. *Blast radius:* DB corruption or lock deadlock.
- **DB corruption on ungraceful shutdown / ENOSPC (HIGH, Memory).** Shadow backup exists but auto-restore not wired. *Blast radius:* memory subsystem unusable after crash until manual recovery.

### Theme D — Tool Crashes & Unsafe Actions (the "blast radius" cluster)
- **ApprovalPolicyEngine not in tool path (CRITICAL, Tool).** *Blast radius:* every destructive native tool and MCP tool executes ungated — file deletion, external API mutations, repo operations, all without human sign-off.
- **MCP tools bypass approval/sandbox (HIGH, Tool).** *Blast radius:* the worst external actions (S3 delete, Slack broadcast) are exactly the ungoverned ones.
- **Tool registry errors propagate uncaught (HIGH, Tool).** *Blast radius:* one buggy tool callback crashes the whole CLI — direct violation of "tool failures must never crash the runtime."
- **Sandboxing not applied to native/MCP tools (HIGH, Tool).** *Blast radius:* no resource isolation; a tool can consume unbounded CPU/FDs/disk.
- **Hung MCP server cascades (MEDIUM→HIGH, Tool).** No client-side request timeout; pending requests accumulate forever. *Blast radius:* memory leak + stalled execution.

### Theme E — Recovery Holes (the "false safety" cluster)
- **DB corruption recovery only in tests (HIGH, Recovery).** *Blast radius:* the recovery code exists and passes tests, but production never invokes it — corruption is fatal in practice.
- **Replay divergence undetected in production (HIGH, Event Sourcing).** ReplayEngine test-only. *Blast radius:* non-deterministic drift goes unnoticed; "replayable" is aspirational.
- **File mutation rollback incomplete (HIGH, Recovery).** Best-effort with per-file error swallowing. *Blast radius:* failed recovery leaves the codebase in a half-reverted, broken state — worse than the original failure.
- **Mutation history truncated under pressure (MEDIUM→HIGH, Recovery).** *Blast radius:* deep rollback impossible exactly when memory pressure (a stress signal) is high.
- **Lease/worker-crash detection latency (MEDIUM, Recovery/Task Graph).** Up to 5s to notice a dead worker. *Blast radius:* bounded stall, but compounds under high concurrency.

---

## 4. Phased Roadmap

### Phase P0 — "Survive unattended at all"
**Goal:** the system can crash and come back, cannot run away, cannot take destructive/external actions ungated, and leaves a durable trail. Nothing below this line should run unattended.

**Work items (ordered):**
1. **Wire EventBus → EventJournal persistence.** Subscribe `journal.appendEvent` to all publishes; batch writes; wrap in `db.transaction()` with a single-writer semaphore. On startup, warm the in-memory journal from SQLite.
2. **Startup recovery bootstrap.** On CLI/runtime init: call `RecoverySupervisor.verifyAndRestore()` inside `getDb()` (gated by `integrityCheck()`); scan `.agency/tasks/*.json` for status in {running, recovering, verifying, paused}; auto-resume (behind `--auto-recover`, default on for daemon mode) or emit a recovery notification.
3. **Recursion + cycle guards on dispatch.** Add `AGENCY_NESTING_DEPTH` and `AGENCY_DELEGATION_CHAIN` env vars; in `dispatchAgent`, reject if depth > max_depth (default 5) or if `req.agentId ∈ chain`. (Two S-effort gaps, highest ROI.)
4. **Approval enforcement in the tool path.** Call `ApprovalPolicyEngine.evaluate()` in `executeTool()` before `registry.invoke()` for write/destructive tools and *all* MCP tools; throw `ApprovalRequiredError` if denied. Register MCP tools with accurate categories.
5. **Fail-safe tool error containment.** Wrap `ToolRegistry.invoke()` so it never re-throws — return a structured error result; callers treat tool errors as data, not exceptions.
6. **Concurrent-write mutual exclusion.** File-level lock map in the task executor; serialize writes to the same path. Add `checkpointMutex` around `saveCheckpointRobust`.
7. **Critical-context protection.** Tag active task/plan/pending-approvals/recent-code-mods as Critical; evict Archive→Useful→Important only; preserve approval state across repack.
8. **Secret enforcement on persistence.** Call `detectSecrets()` inside `addEpisode()` and `insertVector()`; quarantine on hit.
9. **Minimal observability command.** `agency status` (JSON) surfacing active workers, task-graph states, memory telemetry, cost spend.

**Rationale:** P0 closes the five executive threats. Note that 4 of the 9 items are *wiring existing code*, not new builds — fast, high-leverage.

**Risks:** (a) enabling approval gates in the tool path may break existing autonomous flows that assumed silent execution — mitigate with autonomy modes and an explicit `--yes` for trusted pipelines; (b) startup auto-resume could re-run a task that caused the crash — mitigate with a crash-loop counter that escalates to human after N attempts; (c) synchronous journal writes add latency — mitigate with batching + WAL.

**Testing strategy:** kill-9 chaos tests (crash mid-task, mid-write, mid-checkpoint) verifying clean resume; a recursion fuzzer that attempts A→B→A and self-dispatch; an approval-bypass test asserting `delete_file` and a mock MCP tool both block without `--yes`; a concurrent-write race test asserting no lost updates; a secret-injection test asserting quarantine. Gate the phase on a 24-hour soak with induced crashes.

**Rollback strategy:** every P0 behavior change behind a feature flag (`AGENCY_PERSIST_EVENTS`, `AGENCY_AUTO_RECOVER`, `AGENCY_APPROVAL_IN_TOOLPATH`, `AGENCY_DELEGATION_GUARDS`). Default-on in a new "hardened" profile; legacy profile preserves current behavior. Journal persistence is additive (in-memory path unchanged) so it can be disabled without data-path risk.

---

### Phase P1 — "Run for days without degrading"
**Goal:** bounded resource use, accurate attribution, capability-correct routing, and graceful degradation.

**Work items:**
1. **Resource budgets + deadlines:** `execution_budget_ms` / `time_budget` per agent (execa timeout); `max_hops`; mutex around `CostGovernor.recordSpend` (or pre-divide budget by `max_parallel_agents`).
2. **Memory lifecycle scheduler:** interval job invoking `evaluateRetention()`, `verifyIntegrity()`, confidence-based delete; content-hash dedup with UNIQUE constraint; per-(tenant,type) row quotas.
3. **MemoryAgent ownership gate** + worker write-isolation type so only the queue path can mutate.
4. **Agent registry health/utilization + capability routing** in `dispatch_subagent`.
5. **Cross-dispatch loop detection** at orchestrator scope.
6. **Worker-crash detection** via exit-code monitoring (extend `WorkerRegistry`); MCP JSON-RPC request timeout (10s).
7. **Atomic multi-file rollback** via StagingEngine (stage→verify→commit-or-abort); persist compacted mutations to `.agency/tasks/[id].mutations.json` so rollback survives memory-pressure truncation.
8. **Static DAG cycle detection** at `runPlan` start; checkpoint schema versioning + load validation.
9. **Event schema completion** (agent_id, task_id, cost, duration) + `session_summary.md` / `handover.md` generation on milestones/checkpoint.
10. **ContextEscalationEngine wiring** + read-only context snapshot for workers; periodic health monitor for tools/MCP/plugins.

**Rationale:** P1 is what separates "survives a crash" from "runs for weeks." It attacks the memory-rot and runaway-cost themes structurally.

**Risks:** GC mis-tuning could delete useful memory — mitigate with soft-delete + archive tier and a dry-run mode first. Capability routing could mis-route — keep role fallback. Atomic rollback via staging adds latency to recovery — acceptable trade for correctness.

**Testing strategy:** week-long soak with synthetic workload measuring table growth (must plateau), cost ceiling never exceeded under 3x concurrency, dedup ratio, GC reclaim rate; fault injection for worker segfault and hung MCP server asserting bounded detection latency; rollback correctness test asserting all-or-nothing across N files.

**Rollback strategy:** GC and quotas behind flags with conservative defaults (high thresholds first, tighten gradually). Schema versioning is forward-compatible by design (unknown versions trigger migration, not failure). Capability routing toggle falls back to current hardcoded routing.

---

### Phase P2 — "Operate well; tune and observe"
**Goal:** quality, fairness, and rich observability — non-blocking refinements.

**Work items:** decay/confidence updates + lastAccessedAt LRU ranking; importance/citation ranking + graph centrality; priority-based lock scheduling (anti-starvation); configurable `max_parallel_agents` and `max_retry_count`; recovery-strategy fallback to human-escalation after 2 full cycles; 12-state completion (CREATED/PLANNING/READY/BLOCKED/WAITING_APPROVAL/REVIEWING/CANCELLED) with state-machine guards via Proxy on `DagTaskNode`; semantic compaction wiring; full artifact system (id/owner/version/timestamp/rollback); throughput + failure-rate + tool-health metrics; FTS5 event index; centralized audit for all tool/approval/MCP events; unified observe dashboard/TUI.

**Rationale:** these improve longevity and debuggability but the system is already safe and bounded after P1. The 12-state machine is downgraded from the spec's implied P0 to P2 here because the *missing* states (esp. WAITING_APPROVAL, BLOCKED) are partly covered functionally by P0 approval-in-path and dependency-blocking — completing the formal model is correctness-hygiene, not survival.

**Risks:** mostly low; the Proxy-based state guard could surface latent illegal-transition bugs (good, but may be noisy) — land behind a warn-only mode first.

**Testing strategy:** ranking-quality regression suite (retrieval relevance over simulated multi-session corpus); starvation test under sustained lock contention; artifact version/rollback round-trip; metrics-accuracy assertions.

**Rollback strategy:** all P2 items are additive or observability-only; revert by feature flag with no data-path impact.

---

## 5. Key Runtime Contracts & Interfaces

Grounded in existing types (`TaskState`/`VALID_TRANSITIONS` in runner.ts:52-86, `ReplayEvent` in contracts/src/index.ts:36-42, `DispatchAgentOptions` in orchestrator.ts:168-175, `SkillArtifact` in context-delivery.ts:15-22, `DomainSpecialistRegistry` in specialist-registry.ts:48-140, `TaskCheckpoint` in checkpoint.ts).

```typescript
// (A) Task state-machine transition guard — make enforcement structural, not convention.
// Replaces the by-reference `node.state = X` escape hatch (Observability failure mode).
// Extends TaskState union to the full 12-state spec.
type TaskState =
  | 'CREATED' | 'PLANNING' | 'READY' | 'QUEUED' | 'RUNNING' | 'BLOCKED'
  | 'WAITING_APPROVAL' | 'VERIFYING' | 'REVIEWING' | 'RECOVERING'
  | 'COMPLETED' | 'FAILED' | 'SKIPPED' | 'PAUSED' | 'CANCELLED' | 'ABORTED';

interface StateTransition {
  readonly from: TaskState;
  readonly to: TaskState;
  readonly at: number;          // epoch ms
  readonly actor: string;       // agentId or 'orchestrator'
  readonly reason?: string;
}

interface GuardedTaskNode {
  readonly id: string;
  readonly state: TaskState;                 // read-only; mutate only via transition()
  readonly dependencies: readonly string[];
  readonly priority: number;                 // new; default 0
  transition(to: TaskState, ctx: StateTransition): Result<GuardedTaskNode, IllegalTransitionError>;
  // Implementation wraps node in a Proxy that throws on direct `state` assignment.
}
```

```typescript
// (B) Worker read-only context handle — closes "workers receive mutable context" (Context audit).
interface ContextSnapshot {
  readonly snapshotId: string;
  readonly createdAt: number;
  readonly tier: 'critical' | 'important' | 'useful' | 'archive';
  readonly frozen: true;                      // deeply frozen payload
  readonly content: Readonly<Record<string, unknown>>;
  readonly checksum: string;                  // detect tampering on return
}

interface WorkerContextHandle {
  readonly readOnly: true;
  read(): ContextSnapshot;                    // no write method exists by design
  // dispatch_subagent must accept only this handle, never a mutable pack string.
}
```

```typescript
// (C) Agent registry capability descriptor — replaces hardcoded role routing (Swarm audit).
interface AgentCapabilityDescriptor {
  readonly id: AgentId;
  readonly role: string;
  readonly capabilities: readonly string[];   // dynamically matched against task needs
  readonly clearanceLevel: number;
  // runtime-tracked (currently entirely missing):
  health: { successCount: number; failureCount: number; lastError?: string; lastSeen: number };
  utilization: { currentTask: string | null; inFlight: number; maxConcurrent: number };
}

interface AgentRegistry {
  describe(id: AgentId): AgentCapabilityDescriptor | undefined;
  rankForTask(need: { capabilities: string[]; clearance: number }): AgentCapabilityDescriptor[];
  recordOutcome(id: AgentId, ok: boolean, error?: string): void;
}
```

```typescript
// (D) Dispatch guard options — adds the missing delegation safety ceilings (Swarm P0/P1).
interface DispatchAgentOptions {
  agentId: AgentId;
  maxDepth?: number;            // default 5; reject if AGENCY_NESTING_DEPTH exceeds
  maxHops?: number;             // delegation chain length ceiling
  delegationChain?: AgentId[];  // reject if agentId already present (cycle)
  executionBudgetMs?: number;   // default 300_000; hard process timeout
  maxRetryCount?: number;       // default 3; configurable
  budgetSliceUsd?: number;      // pre-allocated share to prevent concurrent overspend
}
```

```typescript
// (E) Event envelope — extends ReplayEvent (contracts:36-42) with the missing attribution fields.
interface EventEnvelope {
  readonly eventId: string;            // distinct from sequenceId
  readonly sequenceId: number;         // existing
  readonly timestamp: number;          // existing
  readonly action: string;             // existing
  readonly agentId?: AgentId;          // NEW
  readonly taskId?: string;            // NEW
  readonly payloadHash: string;        // existing — for replay validation
  readonly payload: unknown;           // existing
  readonly durationMs?: number;        // NEW
  readonly costUsd?: number;           // NEW
  readonly priority: 'CRITICAL' | 'HIGH' | 'NORMAL' | 'LOW';
}

interface DurableEventJournal {
  appendEvent(e: EventEnvelope): void;            // MUST be wired at runtime
  readEvents(fromSeq?: number): EventEnvelope[];  // MUST be called on startup
  queryByTime(startMs: number, endMs: number): EventEnvelope[];
  queryByAgent(id: AgentId): EventEnvelope[];      // backed by FTS5 index (P2)
}
```

```typescript
// (F) Checkpoint manifest — versioned, validated, with provenance (Recovery/Observability).
interface CheckpointManifest {
  readonly schemaVersion: string;       // NEW — enables migration on load
  readonly checkpointId: string;
  readonly createdAt: number;
  readonly checksum: string;            // NEW — CRC validated on read
  readonly status: 'running' | 'paused' | 'recovering' | 'verifying' | 'done' | 'aborted';
  readonly lastSequenceId: number;      // links checkpoint ↔ event journal
  readonly dagState: { nodes: GuardedTaskNode[]; dependencies: Record<string, string[]> };
  readonly mutationLogPath: string;     // .agency/tasks/[id].mutations.json (survives truncation)
}

interface RecoveryBootstrap {
  discoverIncomplete(): CheckpointManifest[];                 // scan .agency/tasks/
  validateAndLoad(m: CheckpointManifest): Result<RuntimeState, CorruptCheckpointError>;
  rebuildFromJournal(fromSeq: number): RuntimeState;          // replay events
  resume(state: RuntimeState, opts: { autoRecover: boolean; maxCrashLoops: number }): void;
}
```

```typescript
// (G) Memory layer + persistence gate — closes 4-layer + ownership gaps (Memory audit).
type MemoryLayer = 'working' | 'session' | 'project' | 'knowledge';

interface MemoryArtifact {
  readonly layer: MemoryLayer;          // NEW — drives TTL/eviction/quota
  readonly contentHash: string;         // NEW — dedup
  readonly confidenceScore: number;     // decayed over time (currently inert)
  readonly secretsScanned: true;        // enforced before persist
}

interface MemoryPersistenceGate {
  // Only the MemoryAgent may call; Orchestrator must approve.
  approveAndPersist(a: MemoryArtifact, approver: 'orchestrator'): Result<void, GateRejected>;
}
```

---

## 6. Migration Strategy

The goal is to land all of the above into the existing 16-package monorepo **without a big-bang rewrite**, exploiting the fact that most P0 work is *wiring inert code*, not building new systems.

**Principle 1 — Wire before you build.** The highest-severity P0 items (event persistence, recovery bootstrap, approval-in-path, RecoverySupervisor invocation) are all "the component exists but is never called." These are surgical: add a subscriber, a startup hook, a call site. No new packages, no schema migrations, minimal blast radius. Do these first to bank the largest risk reduction for the least code.

**Principle 2 — Feature-flag every behavior change behind a "hardened" profile.** Introduce an `AgencyProfile` ('legacy' | 'hardened') read at startup. All P0/P1 behavior changes gate on it: `AGENCY_PERSIST_EVENTS`, `AGENCY_AUTO_RECOVER`, `AGENCY_APPROVAL_IN_TOOLPATH`, `AGENCY_DELEGATION_GUARDS`, `AGENCY_MEMORY_GC`. Legacy preserves today's behavior exactly, so existing tests and users are unaffected; the hardened profile is what runs unattended. This lets you ship to `main` continuously and flip behaviors per-environment.

**Principle 3 — Additive schema evolution with versioning.** Add `schemaVersion` to `TaskCheckpoint` and a migration shim in `loadCheckpoint()` *before* changing any persisted shape. New fields (event `agentId`/`taskId`/`cost`, memory `layer`/`contentHash`, artifact `artifact_id`) are added as nullable/optional first; backfill is lazy. SQLite changes go through additive migrations (new tables/columns, FTS5 virtual tables) — never destructive ALTERs. The `MemoryLayer` (the only XL item) lands as a new nullable column with a default of `'project'`, so existing rows remain valid while layer-aware policies are introduced incrementally.

**Principle 4 — Package ordering respects the dependency graph.** Land contracts first (extend `ReplayEvent`→`EventEnvelope`, `TaskState`, `DispatchAgentOptions` in `packages/contracts`), then leaf utilities (`packages/heuristics`, `packages/workspace`), then `packages/core` wiring, then `packages/cli` surfaces (`agency status`, `--auto-recover`). Each package builds and tests green independently before the next consumes it — the monorepo's existing `tsbuildinfo` incremental builds support this.

**Principle 5 — Dual-write, then cut over, for the journal.** Event persistence ships as *additive*: the in-memory journal path is untouched; the SQLite subscriber is added alongside. Run both for a release, verify the SQLite journal reconstructs state correctly via the (newly-wired) ReplayEngine in warn-only mode, then make startup depend on it. This avoids any window where the data path is broken.

**Principle 6 — Chaos tests as the migration gate.** Stand up a kill-9 / OOM / ENOSPC chaos harness (the Recovery and Memory audits note these are simulated only in unit tests today) and promote it to a CI gate for the hardened profile. No P0 item is "done" until the system survives induced crashes in a 24-hour soak. This converts the audit's recurring "exists but only tested in isolation" anti-pattern into "exercised end-to-end under fault."

**Principle 7 — Sequence the riskiest enforcement changes with escape hatches.** Approval-in-the-tool-path and delegation guards are the changes most likely to break existing autonomous flows. Ship them in warn-only/audit mode first (log what *would* have been blocked), review the audit trail, then flip to enforce. Same for the `DagTaskNode` Proxy state guard (warn on illegal transition before throwing) and memory GC (dry-run reporting reclaim before deleting).

**Concrete first-PR slice (one week, all P0-wiring, all flag-gated):** (1) `EventBus`→`EventJournal` subscriber + startup warm-load; (2) `getDb()` calls `RecoverySupervisor.verifyAndRestore()`; (3) `dispatchAgent` reads/increments `AGENCY_NESTING_DEPTH` + `AGENCY_DELEGATION_CHAIN`; (4) `executeTool()` calls `ApprovalPolicyEngine.evaluate()` in warn-only mode; (5) `ToolRegistry.invoke()` returns structured errors instead of throwing; (6) `agency status` JSON command. Six call-site changes, zero new schemas, fully reversible — and it neutralizes four of the five executive-level threats.