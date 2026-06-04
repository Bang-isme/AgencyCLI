# AgencyCLI — Agent Operating Environment Blueprint

> **Framing.** This is the operating-system-architect view of AgencyCLI. It is a
> *superset* of [`EVENT_FIRST_RUNTIME.md`](EVENT_FIRST_RUNTIME.md) (the canonical
> event-first migration) — it does **not** restate that migration; it adds the
> OS-level layers above it: maturity model, competitor gap analysis, a unified
> execution kernel, a real session hierarchy, a unified supervisor runtime, and a
> forensic replay surface.
>
> **The product is the runtime, not the model.** Every recommendation here
> *extends an existing subsystem*. The repo's two documented diseases —
> **built-but-unwired** and **duplication** — are the failure mode this blueprint
> is most careful to avoid: every "design" section names the canonical home it
> composes (`docs/PACKAGES.md` → Canonical Homes), and nothing proposes a parallel
> system where one already exists.

Legend: ✅ exists & wired · ◐ exists but partial / not composed · ✗ missing.

---

## 1. Executive Summary

AgencyCLI is **not** a chatbot wrapper. It is already a credible **Agent Runtime
trending toward an Agent Operating Environment** (maturity L2→L3). The hard parts
that competitors lack are *already built and wired*:

- a **durable, replayable EventBus** (priority queues, dedup, disk-spill,
  SQLite mirror, hash-verified replay — `events/event-bus.ts` + `replay-engine.ts`);
- a **churn-correctness tool runtime** (reassembly, tail-kept results, edit
  diagnostics, path confinement, `$`-safe replace — all flag-gated, mostly promoted);
- **capability-routed multi-agent orchestration** with delegation guards,
  cost-gated fan-out, concurrency caps, and partial-success merge
  (`agents/orchestrator.ts`);
- a **structural convergence + 0–6 recovery engine** with oscillation detection
  and strategy-entropy selection (`task/convergence-engine.ts`, **wired** into
  `task/runner.ts`);
- **dual memory** — automatic SQLite episodic/vector recall *and* curated,
  human-readable markdown memory (`@agency/memory` + `MarkdownMemoryStore`);
- a **deterministic, flag-gated discipline** (~40 runtime flags, legacy
  byte-identical) that lets every behaviour change ship safely.

**The gap to a true Agent Operating Environment is concentrated in four
keystones**, none of which is "more features" — all four are *integration* of
machinery that already exists:

| # | Keystone | Why it's the bottleneck | Status |
|---|----------|--------------------------|--------|
| **K1** | **`RuntimeState`** — first-class goal/plan/step/file/health state, derived as a reducer over the event journal | Everything operator-facing (Tasks panel, session inspection, recovery decisions, handoff) needs one authoritative state object; today it only exists *inside* `GoalRunner` | ✗ outside `/goal` |
| **K2** | **Session Hierarchy** — a subagent dispatch becomes a *real, inspectable child Session* | Today a subagent is a worker-run + events + a JSON dispatch log; you cannot open it as a session, see its timeline, or replay it | ◐ proto-record exists |
| **K3** | **Supervisor Runtime** — one observer service that subscribes to the bus and composes the 6+ scattered detectors | Loop/stall/runaway/oscillation/timeout detection all exist *separately*; nothing watches the *whole* run and orchestrates recovery | ◐ pieces, no coordinator |
| **K4** | **Activity Timeline surface** — execution-centric TUI fed by events, not parsed text | The TUI still reconstructs activity from `⚡ [SYSTEM:]` text; this is the one architectural defect `EVENT_FIRST_RUNTIME.md §0` names | ◐ render unified, still text |

If those four land, AgencyCLI is demonstrably **more observable, more recoverable,
and more inspectable** than Codex/Claude Code/OpenCode — because the durable
event spine and recovery machinery underneath them already exceed what those tools
expose. The work is *wiring the spine to the surface*, not building a new spine.

**Hard constraints carried from the repo (non-negotiable):**
- Audit → Design → Validate → Plan → Implement → Verify. No code in this document.
- Every behaviour change → a flag in `runtime/flags.ts`, legacy byte-identical.
- No duplication, no built-but-unwired; the 7 integrity guards stay green.
- Never prioritise *more* tools/agents/panels/commands. Consolidate.
- BYOK promotion is the *last* step; never auto-promote hardened→default.

---

## 2. Harness Maturity Assessment

**Maturity ladder:** L0 Tool-Calling Chatbot · L1 Agent Runtime · L2 Harness
Runtime · L3 Agent Operating Environment · L4 Autonomous Agent Infrastructure.

| Subsystem | Where it lives | Score | Rationale (grounded) |
|---|---|:---:|---|
| Agent Runtime (turn/tool loop, continuation) | `chat/{stream,orchestrator,turn-helpers}.ts` | **L3** | Outer tool loop, reassembly, auto-continue, verify-main-turn, tail-kept results — churn-correctness done & promoted |
| Tool Runtime | `@agency/tooling` + `skill/tool-harness.ts` | **L3** | One `ToolRegistry`, 21 tools, confinement/approval/diagnostics; `tool:*` events on bus (Phase A) |
| Event Architecture | `events/event-bus.ts`, `event-journal.ts`, `replay-engine.ts` | **L2→L3** | Durable, priority-queued, dedup, hash-replay — but taxonomy incomplete (`fs/exec/build/checkpoint/memory/safety` families not yet consumed) |
| State Management | `RuntimeState` (only in `GoalRunner`); session = `{id,messages[]}` | **L1** | **K1 gap.** No first-class run state outside `/goal`; chat turn has no goal/plan/step/file state |
| Checkpoint | `task/checkpoint.ts`, `workspace-snapshot` | **L2** | DAG checkpoints + strict integrity exist; but `workspace-snapshot` is mtime/size only (cannot restore content), not generalised to any turn |
| Recovery | `convergence-engine.ts`, `verify-loop.ts`, `autoContinueOnExhaustion`, `autoRecover`, `LeaseManager` | **L2→L3** | Rich primitives, **wired**; not yet *composed* into one diagnose→repair→retry→verify loop driven by a supervisor |
| Agent Orchestration | `agents/orchestrator.ts`, `agent-registry.ts` | **L3** | Capability routing, delegation guards, cost-gate, concurrency cap, isolated workspaces, partial-success merge |
| Subagent / Session Hierarchy | `subagent:*` events + `.agency/agents/dispatch-*.json` | **L1** | **K2 gap.** A subagent is a worker-run, not a session you can open/inspect/replay |
| Supervisor | `WorkerRegistry`, `LoopDetector`, `ConvergenceEngine`, `ProviderSupervisor`, circuit breaker, `withDeadline`, `LeaseManager` | **L1→L2** | **K3 gap.** 6+ detectors, no unified observer; each acts locally |
| Memory | `@agency/memory` + `MarkdownMemoryStore` | **L3→L4** | Episodic+vector+FTS hybrid recall, curated markdown, cross-session, secret-scan, GC/quota, CRDT merge |
| TUI / TUX | `tui/` (Ink), `Conversation.tsx`, `SubagentPanel`, `GoalRunner`, `PlanPanel` | **L2** | **K4 gap.** `timelineParts` unified the render but still *parses text*; no event-fed `ActivityTimeline`; conversation-centric |
| Replay / Forensics | `events/replay-engine.ts` + `telemetry/replay.ts` + `agency replay`/`replay-regression` | **L2** | Two real replay engines; not yet an *operator forensic surface* (no replay-as-timeline / replay-failure / decision-graph) |
| Safety / Governance | `@agency/security` (egress/sandbox/jail), `approval/`, `CostGovernor`, `ProviderSupervisor` | **L3** | Self-kill refusal, egress allow-list, 5-dim risk, approval engine, path confinement, cost ceilings, provider failover |

**Aggregate: L2, strongly trending L3.** The four L1 cells (State, Session
Hierarchy, Supervisor, plus the L2 TUI surface) are exactly K1–K4. They are
*integration* gaps, not capability gaps — the underlying machinery for all four
already exists and is wired elsewhere.

---

## 3. Codex Gap Analysis (Codex App + Codex CLI)

**Where AgencyCLI already leads:**
- **Durable, hash-verified replay journal.** Codex has no first-class
  user-replayable execution journal; AgencyCLI persists every event to SQLite and
  can replay-verify it (`agency replay`).
- **Determinism via flags.** Every behaviour change is reproducible
  (legacy↔hardened, `AGENCY_*` overrides). Codex behaviour is opaque/version-pinned.
- **Recovery depth.** `ConvergenceEngine` (oscillation detection, 0–6 recovery
  levels, causal rollback) exceeds Codex's retry model.

**Where Codex leads / AgencyCLI must close:**
- **Execution-centric surface.** Codex App presents a clean plan/step/diff view;
  AgencyCLI still mixes tool activity into the conversation (→ **K4**).
- **Diff-first review.** Codex foregrounds the patch. AgencyCLI has `PatchCard`
  (structured-only after teardown) but no consolidated artifact/diff browser
  (→ Phase 6 Artifact Inspector, composed from staging-engine + dispatch logs).
- **Continuation invisibility.** Codex hides "continue". AgencyCLI shipped
  `autoContinueOnExhaustion` (Phase E) but the *visible* loop-exhaustion notice
  still appears in legacy paths/old dist (→ **K1 + Phase 9**, already designed).

**Net:** AgencyCLI's *substrate* beats Codex; its *operator surface* trails.
K1+K4 close the visible gap; the substrate advantage is then exposed.

---

## 4. Claude Code Gap Analysis

**Where AgencyCLI already leads:**
- **Curated *and* automatic memory.** AgencyCLI runs both an opaque SQLite
  episodic store *and* a Claude-Code-style human-readable markdown memory
  (`MarkdownMemoryStore` + `remember`/`forget`, `metadata.type`
  user|feedback|project|reference). Claude Code has the markdown layer; AgencyCLI
  has both, fused at recall (`chat/memory-integration.ts`).
- **Built-in multi-agent orchestration with capability routing + health.** Claude
  Code's subagents are simpler; AgencyCLI routes by capability/health and merges
  partial success.
- **Native recovery/convergence engine.** No Claude Code analogue.

**Where Claude Code leads / AgencyCLI must close:**
- **Sub-session inspection.** Claude Code surfaces subagent work clearly;
  AgencyCLI's subagent is not yet an openable session (→ **K2**).
- **Hooks / extensibility surface.** Claude Code's settings/hooks model is a
  first-class extension point. AgencyCLI has skills/plugins (`@agency/skills-bridge`)
  but no user-facing lifecycle-hook contract. (Deliberately *out of scope* here —
  "never more commands"; revisit only if operators ask.)
- **Plan-mode clarity.** Claude Code's plan/todo surface is crisp. AgencyCLI has
  `update_plan` + `PlanPanel` + `GoalRunner` but they are three partial surfaces
  (→ consolidate under **K1** RuntimeState, *not* a new panel).

---

## 5. OpenCode Gap Analysis

OpenCode is the explicit TUI/TUX north star (user priority #2: "rõ ràng như
opencode nhưng tinh chỉnh xịn hơn").

**Where AgencyCLI already leads:**
- **Runtime depth** (events, recovery, memory, orchestration) — OpenCode is a
  cleaner *client*; AgencyCLI is a deeper *runtime*.
- **Determinism & replay** — no OpenCode analogue.

**Where OpenCode leads / AgencyCLI must close:**
- **Flat, calm, execution-first timeline.** OpenCode renders tool activity as a
  flat line-pool, no bordered cards, prose separated from execution. AgencyCLI's
  `timelineParts` got close but still parses text and mixes channels (→ **K4**;
  HARD CONSTRAINT from the TUI recon: *flat line-pool, no bordered cards*).
- **Low cognitive load.** OpenCode shows *who/what/why* fast. AgencyCLI's
  teardown (removed progressive-disclosure/cognition panels) was the right
  direction; the next step is the single Activity Timeline + a compact Status line
  derived from `RuntimeState` (→ K1+K4), not more panels.

**Synthesis across §3–§5:** AgencyCLI does not need parity of *features*. It needs
to *expose its already-superior substrate* through an execution-centric surface
(K4) backed by authoritative state (K1) and inspectable sessions (K2), watched by
a supervisor (K3). That is the entire competitive thesis.

---

## 6. Runtime Architecture (current, grounded)

```
                        ┌──────────────────────────── EventBus (singleton) ───────────────────────────┐
                        │  priority queues (CRIT/HIGH/NORM/LOW) · 5s dedup · 8KB cap+disk-spill ·       │
                        │  32MB ceiling+shedding · durable SQLite mirror (attachDurableJournal) ·       │
                        │  hash-verified replay (replay-engine.ts)                                      │
                        └──▲───────────────▲──────────────▲───────────────▲──────────────▲──────────────┘
                           │ subagent:*    │ plan:updated │ tool:* (A)    │ system:warning│ chat:*
   ┌───────────────────────┴───┐   ┌───────┴────────┐  ┌──┴───────────┐  ┌┴────────────┐ ┌┴───────────────┐
   │ EXECUTION PATHS (6, share helpers, NOT one kernel)                                                    │
   │  runChatTurn[WithStream]  ──▶ tool loop ──▶ ToolRegistry(21) ──▶ verify-loop ──▶ continuation         │
   │  runPlan (DAG)            ──▶ ConvergenceEngine(0–6) ──▶ checkpoint ──▶ LeaseManager                  │
   │  dispatchAgent[sParallel] ──▶ (calls runChatTurnWithStream) ──▶ isolated workspace ──▶ merge          │
   │  runWorkflow (8 chains)   ──▶ skill chain                                                              │
   │  runDueSchedules (cron)   ──▶ workflow                                                                 │
   │  GoalRunner (/goal, TUI)  ──▶ the ONLY first-class RuntimeState today                                 │
   └───────────────────────────────────────────────────────────────────────────────────────────────────┘
        │ shared services: turn-helpers · circuit-breaker(scoped) · approval/RiskAssessor · CostGovernor ·
        │ @agency/memory (episodic+vector+markdown) · @agency/security (egress/sandbox) · workspace staging
        ▼
   TUI (Ink): Conversation.tsx (prose+parsed activity) · SubagentPanel (subagent:*) · PlanPanel (plan:*) ·
              GoalRunner · StatusBar  ──  consumes events for panels, but STILL parses text for tool activity
```

**The structural truths this exposes:**
1. **The bus is the spine and it is durable + replayable.** This is the asset.
2. **Six execution paths converge only at *helpers*, not at a *kernel*.**
   `dispatchAgent` → `runChatTurnWithStream` is the only deep sharing; `runPlan`,
   `runWorkflow`, `runDueSchedules` each re-walk their own envelope.
3. **State is path-local.** Only `GoalRunner` holds a real run state. Everything
   else infers state ad hoc (e.g. the max-loop notice re-lists modified files).
4. **The TUI is *mostly* an event subscriber already** (SubagentPanel/PlanPanel
   prove it) — except for the one channel that matters most (tool activity).

---

## 7. Execution Kernel Design (Phase 3 — unify, do not rewrite)

**Goal:** every execution path shares one envelope: `goal · plan · state · events
· memory · checkpoints · continuation · recovery · completion`.

**Reality check:** they already share `runChatTurnWithStream`, `verify-loop`,
`turn-helpers`, the EventBus, the checkpoint store, and the circuit breaker. The
kernel is therefore an **extraction of the common shell**, not a new runtime.

**Design — `core/kernel/` (the `entropy-provider.ts` leaf already lives here):**

```ts
// shape only — illustration, not final code
interface KernelRun {
  runId: string;              // monotonic, used as event/seq scope
  parentRunId?: string;       // ← K2: subagent runs link to parent
  kind: "chat" | "task" | "agent" | "workflow" | "schedule";
  goal: GoalAnchor;           // reuse heuristics/goal-anchor.ts (compileGoalPillars)
  state: RuntimeState;        // ← K1, the reducer output
  signal: AbortSignal;        // reuse ExecutionContext.signal (contracts)
}

interface ExecutionKernel {
  execute(run: KernelRun): Promise<KernelResult>;
}
```

`kernel.execute()` owns the *cross-cutting* concerns once, for everyone:
- **event emission** with `{runId, parentRunId, seq}` (reuses EventBus);
- **`RuntimeState` reduction** (K1) folded from the same events;
- **checkpoint cadence** (reuses `task/checkpoint.ts`);
- **continuation** (reuses `autoContinueOnExhaustion` + `contextCompaction`);
- **recovery** (reuses `ConvergenceEngine` + `verify-loop`);
- **completion detection** (reuses `turn-helpers.detectIncompleteCompletion`).

Each existing entry point becomes a **thin adapter** that builds a `KernelRun` and
delegates: `runChatTurn` → `kernel.execute({kind:"chat", …})`, `runPlan` →
`{kind:"task"}`, `dispatchAgent` → `{kind:"agent", parentRunId}`, etc. The
*adapters keep their current public signatures* (no caller breaks), so this is
flag-gated (`unifiedKernel`) and legacy byte-identical when off.

**Anti-duplication mandate (explicit):** the kernel imports `turn-helpers`,
`verify-loop`, `EventBus`, `checkpoint.ts`, `circuit-breaker.ts`,
`convergence-engine.ts`. It introduces **zero** new copies of routing, tool
execution, verification, or recovery. It is an *orchestration shell*, and it lives
in a leaf so it cannot form an import cycle (`architecture-cycles.test.ts` guards
this).

**Sequencing:** the kernel is **K1-first**. You cannot unify the envelope until
`RuntimeState` exists, because state is the one thing the paths currently *don't*
share. So Phase 3 follows Phase 4's RuntimeState reducer (§8/K1).

---

## 8. Event Architecture (Phase 4 — extend the taxonomy, derive state)

This section *extends* `EVENT_FIRST_RUNTIME.md §2`; it does not restate it.

**Canonical envelope (superset of today's `ReplayEvent`):**
```
{ ts, runId, parentRunId?, seq, kind, status, payload, meta{agentId,taskId,durationMs,costUsd} }
```
`seq` is the per-run monotonic counter (already added in Phase A). `runId` +
`parentRunId` are the K2 enablers — added to `meta` first (additive, no break),
promoted into the envelope when the kernel lands.

**Event families — present vs to-add:**

| Family | Today | Gap → increment |
|---|---|---|
| `subagent:*`, `plan:*`, `system:warning`, `chat:*`, `security:egress-denied` | ✅ wired, drive panels | — |
| `tool:started\|finished\|failed` | ✅ Phase A (`chat/tool-events.ts`) | consumed by K4 timeline |
| `fs:read\|write\|edit\|delete`, `exec:start\|end`, `build:started\|failed\|success` | ✗ | emit at the tool-harness boundary (additive, no flag for *emit*) |
| `checkpoint:created\|restored` | ✗ (writes happen, no event) | emit from `task/checkpoint.ts` |
| `continuation:started\|completed` | ◐ `continuation:started` exists (Phase E) | add `:completed` |
| `memory:updated` | ✗ | emit from `safeAddEpisode`/`MarkdownMemoryStore` write |
| `safety:blocked` | ◐ egress event exists | generalise to all blocks (§EVENT_FIRST §8) |
| `supervisor:*` (loop/stall/runaway/timeout) | ✗ | **K3** emits these |
| `governance:*` (budget warn/deplete) | ◐ CostGovernor warns in-band | promote to events |
| `session:created\|forked\|completed` | ◐ session store exists | **K2** emits these |

**`RuntimeState` = a pure reducer over the journal (the K1 keystone).** No new
write path: fold the events the bus already persists into:
```
RuntimeState {
  goal, plan[], currentStep, completed[], pending[], failed[],
  modifiedFiles[], builds[], checkpoints[], health, tokens, costUsd
}
```
Because the journal is durable (`persistEvents` default-on) and replayable,
`RuntimeState` is *resumable and replayable for free* — it is just a re-fold of
the journal. This is the single highest-leverage addition in the whole blueprint:
it unblocks the kernel (§7), the Tasks/Status panels (§14), session inspection
(§9), recovery decisions (§12), and auto-handoff memory (§13).

---

## 9. Session Hierarchy Design (Phase 5 — K2)

**Today:** `AgencySession { id, messages[] }` (`tui/sessions/store.ts`,
forkable via `forkSession`). A subagent run is **not** a session — it is
`subagent:*` events + a `.agency/agents/dispatch-<ts>.json` log + (for parallel)
an isolated workspace. The dispatch log is already a *proto session record*.

**Target:**
```
Session {
  id, parentId?, kind: "root" | "subagent" | "workflow-step",
  state: RuntimeState,          // ← K1 per session
  timeline: ReplayEvent[],      // filtered from journal by runId
  artifacts: { files[], patches[], dispatchLog },
  checkpoints: CheckpointRef[],
  memoryScope,                  // inherited (guard 0721095)
}
```

**Design — formalise, don't invent:**
- A subagent dispatch already has a natural `runId` (use it as the child
  `Session.id`); `parentRunId` links it to the parent. **`dispatchAgent` already
  writes `dispatch-<ts>.json`** — promote that path to
  `.agency/sessions/<id>/{meta.json, timeline.jsonl, artifacts/}` and link children
  under the parent. The journal already holds the child's events (filterable by
  `runId`), so the child *timeline* is free.
- **The TUI Session Tree reuses the proven subscribe pattern.** `SubagentPanel`
  already subscribes to `subagent:*` and renders live workers — extend it into a
  read-only **Session Tree** keyed by `parentId`. No new event mechanism.

**The invariant the user specified, enforced in the runtime:** *only the parent
(root) session accepts user input; child sessions are inspectable but not
promptable.* This is a UI affordance backed by `Session.kind` — the composer is
disabled when a non-root session is focused. This is a *constraint*, not a
feature: it keeps cognitive load low and prevents the "which agent am I talking
to?" confusion the screenshots hint at.

**Anti-duplication:** reuse `tui/sessions/store.ts` schema (extend, don't fork),
the existing `subagent:*` events, the existing dispatch logs, and `forkSession`.
Do **not** create a second session store.

---

## 10. Parallel Agent Design (Phase 6 — compose read-only inspectors)

Everything here is a **read-only subscriber** over existing data — *zero* new
runtime, honouring "never more panels" by consolidating into one dashboard view
with switchable inspectors rather than many always-on panels.

| Inspector | Composed from (existing) |
|---|---|
| **Parallel Agent Dashboard** | `SubagentPanel` (live `subagent:*`) + `capabilityRegistry` health/utilization (`markInFlight`/`recordOutcome`) |
| **Session Tree** | K2 sessions keyed by `parentId` (§9) |
| **Worker Inspector** | per-session `timeline.jsonl` (journal filtered by `runId`) |
| **Artifact Inspector** | `StagingEngine` staged files + `dispatch-*.json` `filesWritten` + `PatchCard` |
| **Checkpoint Inspector** | `task/checkpoint.ts` `listCheckpoints` + DAG integrity |
| **Memory Inspector** | `MarkdownMemoryStore` index + episodic `getRecentAcrossSessions` |
| **Agent Health Monitor** | `capabilityRegistry` + `CostGovernor` per-agent cost (event `meta.costUsd`) |
| **Supervisor Monitor** | K3 `supervisor:*` events (§11) |

**3-second comprehension test (user's Phase 6/13 bar):** the dashboard's default
view answers *who is running · what they're doing · why · what they produced* from
`subagent:progress.phase` + `RuntimeState.goal` + `artifacts`. All four already
flow on the bus; the dashboard is a layout over them.

---

## 11. Supervisor Design (Phase 7 — K3, the biggest compose-don't-build win)

**Today: 6+ detectors, no coordinator.** Each acts locally and blindly:
- `WorkerRegistry` — child-process RSS monitor, kills >512MB process trees (1s tick)
- `LoopDetector` (`@agency/heuristics`) — identical errors/prompts/patch cycles
- `ConvergenceEngine.detectOscillation` — build-failure & file-edit oscillation
- `circuit-breaker.ts` (`scopedCircuitBreaker`, `breakerFailedExits`) — consecutive failures
- `withDeadline` + `executionBudgetMs` — per-dispatch wall-clock
- `enforceDelegationLimits` — depth/hop/cycle
- `LeaseManager` — lease heartbeat, stall→fail, crash-resume
- `ProviderSupervisor` (`@agency/governance`) — provider health/failover
- memory `Supervisor`/`RecoverySupervisor`/`GraphIntegritySupervisor`

**Design — one `SupervisorService` that *observes the whole run*:**

```
SupervisorService  (a pure EventBus subscriber; executes NO task work)
  subscribes: tool:* · fs:* · exec:* · build:* · subagent:* · plan:* · continuation:*
  composes (does NOT reimplement): LoopDetector · ConvergenceEngine.detectOscillation ·
            circuit-breaker signals · WorkerRegistry RSS · withDeadline timeouts ·
            LeaseManager stalls · ProviderSupervisor health
  emits: supervisor:loop-detected | stuck-worker | runaway-tool | deadlock |
         timeout | resource-pressure | agent-replaced | recovery-suggested
  triggers (existing primitives): checkpoint restore · continuation spawn ·
            agent replacement · circuit-breaker trip · graceful halt + one calm line
```

The supervisor is the missing *coordinator*: it folds the same `RuntimeState`
(K1) the rest of the system uses, so it sees cross-detector patterns no single
detector can (e.g. "build oscillating *and* no `fs:write` progress *and* breaker
near trip" → escalate to `terminate` strategy with a post-mortem, instead of three
detectors each waiting). It **executes nothing itself** — it emits
`supervisor:*` events and invokes existing recovery primitives, keeping the
"observer, not executor" separation the user specified.

**Why this is safe and non-duplicative:** it is a new *leaf subscriber*, it adds
no detection logic (only aggregation + policy), and its outputs are events the TUI
already knows how to render. It directly attacks the screenshot failure (circuit
breaker tripping after a runaway) by *seeing it coming* and checkpointing first.

---

## 12. Recovery Design (Phase 8 — compose into one diagnose→repair→retry→verify→resume)

The primitives are all present and wired; the design formalises them into one
**`RecoveryPlan`** the Supervisor (§11) drives:

```
on supervisor:* →
  diagnose  : classify failure (build | tool | crash | network | merge | mem/ckpt corruption)
              using FailureNormalizer + ConvergenceEngine structural metrics
  selectStrategy : ConvergenceEngine.selectRecoveryStrategy(attempted)
              → targeted | isolation | rebuild | rollback | compaction | terminate
              (entropy-decayed so it never repeats a failed strategy)
  repair    : verify-loop self-heal · applyCausalRollback · autoRecover crash-resume ·
              ProviderSupervisor failover · checkpoint restore (checkpointStrict)
  retry     : bounded (maxCrashLoops, verifyMaxRounds) with no-progress detection
  verify    : staging-engine shadow build + acceptance commands
  resume    : continuation (§13) from the last good checkpoint
```

**Coverage extension (the user's Phase 8 list), each mapped to an existing tool:**
- tool failures → circuit breaker + `diagnoseEditMismatch`
- build failures → `verify-loop` + `convergence` oscillation + tail-kept errors
- agent crashes → `autoRecover` + `LeaseManager` crash-resume
- network failures → `ProviderSupervisor` failover + `isTransientError` backoff
- merge conflicts → `mergeWorkspaceChanges` partial-success (already returns conflicts)
- memory corruption → memory `RecoverySupervisor` (shadow backup) + `secretScan`
- checkpoint corruption → `checkpointStrict` (reject + restore prior)

**The only new code is the `RecoveryPlan` driver** that sequences these — and it
lives behind a flag, composing existing functions. No new repair mechanism.

---

## 13. Continuation Design (Phase 9 — invisible, already largely shipped)

`autoContinueOnExhaustion` (Phase E, `411b2e2`, default-on) already implements the
core: a productive iteration that would hit `maxLoops` extends its budget by one
window, guarded by (1) progress-gating (files-written must keep growing), (2) a
hard ceiling (`maxLoops × 4`), (3) the circuit breaker — *exactly the three guards
the 6-minute runaway lacked*.

**Remaining work to make continuation fully invisible (extends EVENT_FIRST §7):**
1. **Wrap it in the kernel envelope** so *every* path (not just chat) continues
   invisibly: checkpoint → `contextCompaction` compress → `continuation:started`
   → resume → `continuation:completed`.
2. **Cross-run budget** (not just per-turn): the Supervisor (K3) holds the budget
   and the no-progress detector, so continuation across a *session* (incl.
   subagents) can't recreate a runaway.
3. **Replace the residual visible notice.** The user must never see "send
   continue" / "tool limit reached" / "context limit reached". The
   `buildIncompleteTurnNotice` line becomes a quiet timeline row (`↻ continuing…`),
   surfaced only as one calm line *if* the no-progress detector finally stops it.

**Critical caveat carried forward:** this is the highest-runaway-risk change.
Promotion requires **live validation on a real big build** (the
`D:\AnimeSoul\aniverse` class of task) — and the user must rebuild dist first
(the recurring "old dist" trap).

---

## 14. Memory Architecture (Phase 10 — taxonomy over existing stores)

Mostly a *taxonomy* over machinery that exists; extends `EVENT_FIRST §5`.

**Layered memory, mapped to homes (no new store):**

| Layer (user's Phase 10) | Home today | Increment |
|---|---|---|
| Architecture / ADR | `MarkdownMemoryStore` `metadata.type` | add `adr` type |
| Operational | markdown `project` type | reuse |
| Knowledge | episodic + vector (`HybridRetriever`) | reuse |
| Execution | event journal (durable) | reuse — it *is* execution memory |
| Recovery | post-mortem log + `replayLog` (convergence) | surface as `recovery` type |
| Session | K2 `.agency/sessions/<id>/` | reuse |
| Handoff | `runtime/handover.ts` + markdown | add `handoff` type + auto-write |
| Subagent | inherited scope (guard `0721095`) | reuse |

**Auto-handoff (the operator payoff):** on `continuation:started` / session end,
`writeHandoff(RuntimeState)` generates a `handoff`-typed markdown memory (goal,
plan, completed/pending, modified files) from K1 state. This makes long-running
and multi-session work *resume itself* — the persistent-memory mandate
(NEXT_SESSION_PROMPT §3(e)) realised at runtime, not just by the human.

**Invariant:** all memory remains compressible, searchable (`HybridRetriever` +
FTS), inspectable (Memory Inspector §10), replayable (journal), recoverable
(memory `RecoverySupervisor`). Don't add a parallel markdown store or recall path
(Canonical Homes mandate).

---

## 15. TUI/TUX Architecture (Phases 11–13 — K4, the visible payoff)

Target layout (operator clarity in 3 seconds), extending `EVENT_FIRST §9` and the
TUI-opencode-parity plan. **HARD CONSTRAINT (from the render recon): flat
line-pool, no bordered cards; prose and execution are different channels.**

```
┌ Conversation ──────────────┐  onDelta prose ONLY (summaries, decisions, findings)
│ "Build failed: tailwind cfg"│
│ "Fixed and rebuilt."        │
├ Activity Timeline ─────────┤  EventBus-fed (tool:*/fs:*/exec:*/build:*), flat, virtualized, filterable
│ ✓ write Hero.tsx           │
│ ✓ exec npm run build       │
│ ✗ build failed             │
│ ✓ edit globals.css         │
│ ✓ build success            │
├ Tasks ─────────────────────┤  RuntimeState.plan/steps  (consolidates PlanPanel+GoalRunner — NOT a new panel)
├ Sessions ──────────────────┤  K2 Session Tree (read-only; only root is promptable)
└ Status ────────────────────┘  model · tokens · breaker · checkpoint · supervisor health  (one line, from RuntimeState)
```

**The keystone change (K4):**
- `<ActivityTimeline>` subscribes to events via `useRuntimeEvents()` — the *same*
  pattern `SubagentPanel` uses for `subagent:*`. When its flag
  (`eventDrivenActivity`) is on, the `⚡ [SYSTEM:]` `onDelta` text injection is
  **suppressed**, and `Conversation.tsx` renders prose only. Off = today's
  behaviour byte-identical.
- **Cognitive-load rules (Phase 13), enforced in the render contract:** never show
  raw reasoning, internal monologue, tool spam, or debug spam in the Conversation;
  the timeline carries *what*, the conversation carries *why* (a summary). This is
  the principled version of the teardown the repo already did (removed
  progressive-disclosure/cognition panels).
- **Consolidation, not addition:** Tasks merges `PlanPanel` + `GoalRunner` under
  one `RuntimeState`-fed view. The net panel count should *not* grow — the user's
  "never more panels" rule is satisfied by replacing parsed-text rendering with
  event-fed rendering and folding three plan surfaces into one.

---

## 16. Replay Architecture (Phase 15 — promote two engines into one forensic surface)

Two real replay engines exist and must **not** be merged (different domains — see
Canonical Homes "Intentional name-collisions"):
- `events/replay-engine.ts` — verifies the journal by hash (`agency replay`).
- `telemetry/replay.ts` — replays a `DeterministicExecutionTrace`, overriding live
  tool/clock outputs (`agency replay-regression`).

**Design — an operator forensic *surface* composed over both (no third engine):**

| Capability (user's Phase 15) | Composed from |
|---|---|
| **Replay Session** | journal filtered by `runId` → rendered through the *same* `<ActivityTimeline>` component (K4) |
| **Replay Agent** | K2 child session's `timeline.jsonl` |
| **Replay Failure** | jump to first `*:failed`/`Exit Code:` event + the `supervisor:*` + recovery chain that followed |
| **Replay Recovery** | `convergence` `replayLog` + `RecoveryPlan` events (§12) |
| **Replay Timeline** | the journal *is* the timeline (event-sourced — §8) |
| **Replay Decision Graph** | `subagent:routed` + `plan:*` + capability-routing events → a route/dispatch graph |

Because the runtime is event-sourced (§8), **replay is not a separate
capability — it is the journal re-rendered.** Forensic analysis falls out of K1+K4
for free. The `agency replay` command becomes the headless entry; the TUI gets a
"replay this session/agent" affordance that reuses the live timeline component.

---

## 17. Migration Strategy

**Discipline (unchanged from the repo):** flag in `runtime/flags.ts`, legacy
byte-identical when off, small single-concern commits on `master`, `pnpm verify`
REAL_EXIT_CODE=0, the 7 integrity guards stay green, no auto-promote, BYOK last.

**Dependency order (why this sequence):**

```
K1 RuntimeState reducer  ──┬─▶ K3 Supervisor (folds RuntimeState)
 (Phase 4, flag           │     (Phase 7, flag supervisorRuntime)
  runtimeState)           │
        │                 ├─▶ K2 Session Hierarchy (per-session RuntimeState)
        │                 │     (Phase 5, flag sessionHierarchy)
        │                 │
        ├─▶ Phase 3 Kernel (needs RuntimeState to unify the envelope)
        │     (flag unifiedKernel)
        │
        └─▶ K4 Activity Timeline + Tasks/Status from RuntimeState
              (Phase 11, flag eventDrivenActivity)  ← the visible payoff
                    │
                    └─▶ Phase 6 Dashboard/Inspectors · Phase 15 Replay surface
                          (read-only subscribers, low risk)
```

**K1 is the unlock for everything.** It is also low-risk (a pure reducer over an
already-durable journal — no new write path). Ship it first.

**Map to the existing EVENT_FIRST phases:** EVENT_FIRST A/E are done
(`tool:*` events, invisible-continuation core, `timelineParts` promoted). This
blueprint's K4 == EVENT_FIRST B/C (Activity Timeline + cut the text round-trip);
K1 == EVENT_FIRST D (RuntimeState reducer). The OS-level additions beyond
EVENT_FIRST are **K2 (Session Hierarchy)**, **K3 (Supervisor Runtime)**, **Phase 3
(Unified Kernel)**, and **Phase 16 (Replay surface)**.

---

## 18. Risk Analysis

| Risk | Severity | Mitigation (grounded in repo practice) |
|---|---|---|
| **Duplication** — building a parallel state/session/supervisor/replay system | **High** | Every design above names the canonical home it composes; the architecture-cycles + package-cycles + dup-scan guards catch a parallel module |
| **Built-but-unwired** — shipping `RuntimeState`/Supervisor that nothing reads | **High** | K1 wires into TUI Status *in the same slice*; K3 emits events the TUI already renders; verify-don't-assert (run `agency status`/replay, don't claim) |
| **Continuation runaway** (the 6-min screenshot) | **High** | The 3 guards already exist (progress-gate, ceiling, breaker); K3 adds the cross-run budget; **live-validate before promote** |
| **Event ordering non-determinism** | Medium | `seq` per run already added (Phase A); RuntimeState is a deterministic fold; replay hash-verifies it |
| **"Old dist" trap** — fixes invisible until `pnpm -r build` + restart | Medium | Every handoff must remind the user to rebuild (recurring memory note); consider a dist-staleness banner |
| **Over-paneling** — violating "never more panels" | Medium | K4 *consolidates* (3 plan surfaces → 1 Tasks view; parsed-text → event-fed); net panel count must not grow |
| **TUI render regression** (user is the only validator — "I can't see the TUI") | Medium | Flag-gated, off by default, user visually validates before promote (the standing gate) |
| **BYOK-blocked validation** — live churn/continuation needs a real key | Medium | Correctness paths covered by deterministic tests (no provider); defer provider-dependent eval to the BYOK-last step |
| **Scope/time** — 4 keystones is large | Medium | Slice per keystone; K1 alone delivers most of the value (state + handoff + status) and is independently shippable |

---

## 19. Success Metrics

Operator-centric, measurable, mapped to the design priorities (Reliability,
Recoverability, Observability, Continuation, Low Cognitive Load):

1. **Time-to-understand ≤ 3s** — an operator can name *current goal · phase ·
   progress · blockers · health* from one screen (K1+K4). (User-validated.)
2. **Continuation invisibility = 100%** — zero occurrences of "send continue" /
   "tool limit reached" / "context limit reached" in normal runs (Phase 9 + K1).
3. **Recovery autonomy rate** — % of build/tool/crash failures resolved without
   user intervention (Supervisor + RecoveryPlan), trended over real runs.
4. **Replay fidelity = hash-match** — every recorded session re-folds to an
   identical `RuntimeState` (`agency replay` + regression).
5. **Event coverage** — % of execution actions that emit a structured event
   (target: tool/fs/exec/build/checkpoint/memory/safety all covered; no
   action visible only as parsed text).
6. **Session inspectability** — every subagent run is openable as a session with a
   timeline + artifacts (K2); 0 "stuck running" phantom workers.
7. **Zero new duplication / zero built-but-unwired** — the 7 integrity guards +
   the dup/dead-export sweeps stay clean across the whole campaign.
8. **Legacy byte-identical** — every flag off reproduces today's behaviour exactly
   (the repo's core invariant).

---

## 20. Implementation Roadmap

Ordered slices, each a flag + small commits + `pnpm verify` green + the user's
visual validation where it touches the TUI. **No code is written until K1's design
is validated against the live journal** (Audit → Design → **Validate** → Plan →
Implement → Verify).

**Slice 0 — Validate the journal substrate (no code).**
Run `agency replay` / `agency status` / inspect `.agency/` on a real session;
confirm the journal carries enough to fold `RuntimeState`. Report gaps.

**Slice 1 — K1 `RuntimeState` reducer (flag `runtimeState`).**
Pure fold over the EventBus journal → `{goal,plan,steps,modifiedFiles,builds,
health,tokens,cost}`. Wire into `agency status --json` *and* the TUI StatusBar in
the same slice (no built-but-unwired). Add the missing `fs:*`/`exec:*`/`build:*`/
`checkpoint:*`/`memory:*` event emits (additive, no flag for emit).

**Slice 2 — K4 Activity Timeline (flag `eventDrivenActivity`).**
`<ActivityTimeline>` + `useRuntimeEvents()`; suppress the `⚡ [SYSTEM:]` `onDelta`
injection when on; Conversation = prose only. Flat line-pool, no cards. *User
visually validates.* (== EVENT_FIRST B/C.)

**Slice 3 — Tasks/Status consolidation (same flag).**
Fold `PlanPanel` + `GoalRunner` into one `RuntimeState`-fed Tasks view. Net panel
count does not grow.

**Slice 4 — K2 Session Hierarchy (flag `sessionHierarchy`).**
Promote `dispatch-*.json` → `.agency/sessions/<id>/`; per-session `RuntimeState`;
read-only Session Tree in the TUI (only root promptable). Reuse `subagent:*` +
session store.

**Slice 5 — K3 Supervisor Runtime (flag `supervisorRuntime`).**
One `SupervisorService` subscriber composing the 6+ detectors; emits
`supervisor:*`; drives `RecoveryPlan`. Observer-only.

**Slice 6 — Phase 3 Unified Kernel (flag `unifiedKernel`).**
Extract the common envelope into `core/kernel/`; convert the 6 paths to thin
adapters. Legacy byte-identical when off.

**Slice 7 — RecoveryPlan + invisible continuation generalisation (flag
`recoveryPlan`).** Sequence the existing repair primitives; cross-run budget via
K3. **Live-validate on a real big build before promote.**

**Slice 8 — Auto-handoff memory + ADR/recovery types (Phase 10/13).**
`writeHandoff(RuntimeState)` on continuation/teardown; markdown type union extension.

**Slice 9 — Replay/Dashboard surfaces (read-only).**
Replay-as-timeline + Worker/Artifact/Checkpoint/Memory inspectors — all
subscribers over K1/K2/journal. Lowest risk; ship last.

**Slice 10 — Promotion + BYOK (LAST).**
Only after the user visually validates each TUI flag and runs a real-key session:
promote validated flags hardened→default with explicit user OK; then the BYOK
eval. Never auto-promote.

---

### Appendix A — What NOT to rebuild (anti-duplication ledger)

Already exist & wired — **extend, never re-implement** (Canonical Homes):
EventBus + durable journal + replay-engine · checkpoint store + DAG integrity ·
circuit breaker (scoped) · approval/RiskAssessor + egress proxy + sandbox + path
confinement · ConvergenceEngine (recovery levels/oscillation/strategy-entropy) ·
LeaseManager + autoRecover + discoverRecoverableTasks · verify-loop/verify-turn ·
capability registry + orchestrator + parallel dispatch + delegation guards ·
memory (episodic+vector+HybridRetriever+MarkdownMemoryStore+remember/forget) ·
CostGovernor + ProviderSupervisor · staging-engine + lock-manager + workspace
isolation · turn-helpers (completion detection, compaction, token cost) ·
goal-anchor · the 8 manifest agents + skills/plugin pipeline.

The four keystones (K1–K4) and the unified kernel are **orchestration shells and
read-only surfaces over these** — that is the whole point. The moment a slice
introduces a second state store, a second supervisor, a second session store, a
second replay engine, or a second tool path, it has reintroduced the disease this
blueprint exists to cure.
