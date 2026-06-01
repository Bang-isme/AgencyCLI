# AgencyCLI Production-Hardening — Session Handoff

> **Read this first.** This is the living handoff for the production-hardening initiative.
> Companion docs: [PRODUCTION_AUDIT.md](PRODUCTION_AUDIT.md) (verdict, gap matrix, roadmap, contracts),
> [PRODUCTION_AUDIT_APPENDIX.md](PRODUCTION_AUDIT_APPENDIX.md) (per-subsystem `file:line` evidence), and
> [ROADMAP_HANDOFF.md](ROADMAP_HANDOFF.md) (the bigger plan: từ "không sập" → harness thật → đo được độ tin cậy).
> Last updated: 2026-05-30.

---

## 1. Goal & mental model

Turn AgencyCLI (16-package local-first agent runtime, **not** a chatbot) into something that can
"operate autonomously for weeks while remaining recoverable, observable, debuggable."

The audit's central finding — and the rule that governs all this work:

> **The safety machinery already exists but is not wired into the live runtime path.**
> Components are built, unit-tested, exported… then never instantiated in production.

So the working principle is **"wire before you build"**: prefer adding a subscriber / call-site /
startup hook over writing new mechanisms. Most remaining work is wiring, not invention.

---

## 2. Hard conventions (follow these — they are load-bearing)

1. **Every behaviour change is gated in `packages/core/src/runtime/flags.ts`.**
   `AGENCY_PROFILE=legacy|hardened`. **`legacy` must reproduce pre-hardening behaviour exactly.**
   - Purely-protective + additive changes (durable journal, delegation guards, MCP timeout) → **on in both**.
   - Behaviour-changing changes (auto-recover, approval enforce, memory GC, execution deadline) → **off in legacy, on in hardened**, with a per-flag env override.
2. **Flag-gated risky changes default to warn/off, then enforce.** e.g. approval-in-toolpath ships `warn` (observe what *would* block) before `enforce`.
3. **Never let infra crash the host.** Durable writes, GC, bootstrap, MCP calls, tool execution are all best-effort: wrap in try/catch, return structured errors, log via EventBus — never throw into the runtime.
4. **Test pattern:** per-package `vitest`. New behaviour gets a focused test file. Verify with
   `pnpm -r build` then `pnpm --filter @agency/<pkg> test`. Clear flag env in `afterEach`.
5. **Watch for stale committed `.js`/`.d.ts` in `src/` dirs** — they shadow `.ts` under vitest.
   We removed a set in `packages/governance/src/`. Check `find packages/*/src -name '*.js'` if a test
   mysteriously runs old code. (Only governance was affected at last check.)
6. **Windows:** `getDb()` caches an open SQLite handle; call `closeAllDbs()` before `rmSync` in tests
   or you get EBUSY.

---

## 3. What is DONE (verified 2026-06-01 via `pnpm verify` — self-run, not inherited: full `pnpm -r build` clean 16/16; core 344 / cli 571 / tui 115 / memory 36 / workspace 11 / benchmark 18 / governance 7 / providers 840 / security 35 / tooling 14 / skills-bridge 13 / context 6 / heuristics 6 / browser 5 / telemetry 9 — **~2030 tests pass, exit 0**, full `pnpm -r` sweep green under concurrent load. Core moved 350→…→348 (§2.5 trace-recorder); cli 550→556 (§2.5 `replay-regression` driver, +6); core 348→328 (deleted 2 dead modules — §5 cont'd 9) →329 (wired the cognition producer, +1 gating test — §5 cont'd 10) →332 (3 more cognition emit points + `emitVerifyRoundThought`, +3 tests — §5 cont'd 11); cli 556→561 (bundled-skills integrity guard, +5 — §5 cont'd 12); core 332→337 (agent-dispatch-space integrity guard, +5 — §5 cont'd 13); cli 561→564 (`agency status` flag-view completeness — surface the 6 hidden behaviour flags + guard, +3 — §5 cont'd 14); `ChatMessage` consolidated into providers (type-only, no count change — §5 cont'd 15); cli 564→565 (`agency doctor` runtime skills-pack integrity check, +1 — §5 cont'd 16). Wired-or-dead initiative closed 100% for index.ts exports, then extended to non-exported modules. Harness/tools/skills/agents inventory documented in PACKAGES.md "Harness, built-in tools & skills".)

All 5 CRITICAL threats from the audit are closed, plus several HIGH clusters.

### P0 first-PR slice — survive unattended
| Item | Where |
|---|---|
| Central feature flags (`AgencyProfile`) | `packages/core/src/runtime/flags.ts` |
| EventBus → durable `EventJournal` (warm-load + sink hook) | `events/event-bus.ts` (`attachDurableJournal`), `runtime/bootstrap.ts` (`initEventPersistence`) |
| Startup recovery discovery (scan `.agency/tasks` for resumable) | `runtime/bootstrap.ts` (`bootstrapRuntime`, `discoverRecoverableTasks`), wired into `cli/commands/chat.ts` |
| Delegation depth/hop/cycle guards (env-propagated) | `agents/orchestrator.ts` (`enforceDelegationLimits`, `DelegationLimitError`) |
| Approval gate in the tool path (off/warn/enforce) | `skill/tool-harness.ts` (preExecuteHook + `toolApprovalEngine`) |
| Fail-safe tool exec (never throws) | `packages/tooling/src/tool-registry.ts` (`invokeSafe`, `SafeInvokeResult`) |
| `agency status` (human + `--json`) | `cli/commands/status.ts`, `register.ts`, `tui-launch.ts` |

### P1 slice 1 — bounded memory growth (5th CRITICAL)
- 6 SQL ops on `SqliteStorageBackend`: `countEpisodes/countVectors/pruneEpisodesByQuota/pruneVectorsByQuota/dedupeEpisodes/applyEpisodeDecay` (`memory/src/storage-backend.ts`).
- `MemoryLifecycleManager` + `runMemoryMaintenance()` (`memory/src/lifecycle-manager.ts`): one transactional cycle decay→dedupe→quota-prune→optional vacuum. FTS auto-syncs via existing triggers.
- Flags `AGENCY_MEMORY_GC` / `AGENCY_MEMORY_MAX_EPISODES` / `AGENCY_MEMORY_MAX_VECTORS`. Wired into `bootstrapRuntime`; `getMemoryTelemetry()` surfaces live size in `agency status`.

### P1 slice 2 — runaway-execution controls
- Per-agent wall-clock deadline: `withDeadline()` wrapping `runChatTurnWithStream` in `dispatchAgent`; `DispatchTimeoutError` → existing catch → clean exitCode-1. Flag `AGENCY_EXECUTION_BUDGET_MS` (legacy 0 / hardened 300000).
- Configurable `AGENCY_MAX_PARALLEL_AGENTS` (was hardcoded 3) in `dispatchAgentsParallel`.
- `CostGovernor.tryReserve()` (atomic, no overshoot) + `getRemaining()` (`governance/src/cost-governance.ts`); parallel dispatch skips launching NEW agents once budget depleted (`subagent:skipped`).
- **Removed stale build artifacts** in `packages/governance/src/` (`cost-governance.js/.d.ts/maps`) — governance tests now exercise live source.

### P1 slice 3 — MCP approval + JSON-RPC timeout
- Approval hook now gates any tool carrying the `mcpSchema` marker (MCP tools), passing `__externalTool:true`.
- `RiskAssessor` floors `__externalTool` at MEDIUM (network 0.5) so MCP calls hit the gate instead of LOW-auto-approving (`approval/risk-assessor.ts`).
- `McpClient.request()` has a timeout (`AGENCY_MCP_REQUEST_TIMEOUT_MS`, default 30000, on both profiles); timers cleared on response/exit → no pending-promise leak (`mcp/client.ts`).

### P1 slice 4 — event schema + handover
- `ReplayEvent` gained optional `agentId/taskId/durationMs/costUsd` (additive; **never** folded into replay/dedup hash). `EventBus.publish(action, payload, meta?)`. `EventJournal` got 4 nullable columns + safe `ALTER TABLE` migration; append/read round-trip them.
- `generateHandover()` → `.agency/handover.md` (`core/src/runtime/handover.ts`) + `agency handover [--print]` command.

### P1 slice 6 — TUI freeze fix (event-loop starvation) + slice (B) attribution (2026-05-30)
**Reported bug:** while a subagent streams, the *main* loading spinner and the "elapsed" second
counter freeze (and the subagent spinner too); the number only advances when you press a key
(Ctrl+O). Everything un-sticks on input → classic event-loop starvation, not a state bug.
**Root cause:** `dispatchAgent` (`agents/orchestrator.ts`) re-published a `subagent:progress`
event **on every token**, carrying the *full accumulated* `subagentText`/`subagentThought`
(plus a no-subscriber `thought:journal`). In `EventBus.publish` each event does a
`JSON.stringify` + `sha256` over the whole payload (O(n) → O(n²) across a response) and, once a
payload crosses `MAX_EVENT_BYTES` (8KB), the bus did a **synchronous `writeFileSync`** spill of
the ever-growing payload *per token*. That blocking write per token starved the loop, so every
timer-driven re-render (spinner frame clock + `ToolActivity`'s 200ms elapsed `setInterval`)
stalled until a keypress forced a render. The TUI never even reads those `text`/`thought`
payloads (`App.tsx handleSubagentProgress` only uses `phase`/`step`/`elapsedMs`).
**Fix (two layers):**
1. `orchestrator.ts` — throttle streaming/thinking progress to ≥200ms and emit a *constant-size*
   heartbeat (`phase` + `chars` + `elapsedMs`), never the unbounded buffer; first delta still
   fires immediately. Dropped the dead `thought:journal` spam.
2. `events/event-bus.ts` — large-payload spill is now **async + off the hot path**
   (`spillLargePayload`, `fs/promises`), best-effort, never blocks or aborts publish. Defense-in-depth
   so any future high-frequency large publisher can't re-freeze the loop.
**Slice (B) event attribution (roadmap §1B / §5B) — started here:** the subagent lifecycle
publishes in `dispatchAgent` now pass the `meta` 3rd arg — `subagent:started`/`subagent:routed`
carry `agentId`; `subagent:finished`/`subagent:error` carry `agentId` + `durationMs`. These land
in the `EventJournal` attribution columns (slice 4) for forensics. **Remaining for (B):**
`chat/orchestrator.ts` + `chat/stream.ts` token→cost `costUsd` attribution (needs
`globalCostGovernor` estimate). No new flag (additive).
**Follow-up — steady-state responsiveness (TUI):** after the hard freeze was gone the elapsed
counters still felt laggy (~1–3s, occasional stalls) under streaming load. Cause: the App
re-flushed the *entire* `subagents` array every second (`liveElapsedTimer` heartbeat) purely to
advance the second counters → a full-App reconcile + ConPTY frame write/sec, plus the subagent
counter rode the throttled `setSubagents` prop. Fix: thread a stable `spawnTs` into
`SubagentStatus`; the elapsed readouts now **self-tick in leaf components** (`LiveElapsed` in
`SubagentPanel.tsx` via a 500ms `setInterval`; the bottom-line worker counter in `ToolActivity`
rides its existing 200ms timer using `spawnTs`). Removed the 1s heartbeat entirely and floored the
`setSubagents` cadence at 250ms (4Hz) — elapsed is decoupled now, so phase/step only need 4Hz.
Net: far fewer full-App reconciles / ConPTY writes during subagent runs → counters stay live, main
counter drifts less. (`App.tsx`, `components/SubagentPanel.tsx`, `components/ToolActivity.tsx`.)
**Tests:** `event-bus.test.ts` (+1: oversized payload → small ref + async spill, never a sync
write), `agents-orchestrator.test.ts` (+2: streaming throttle/no-full-transcript; lifecycle events
carry `agentId`/`durationMs`). Verified: full `pnpm -r build` clean, core **303** green, tui **113**
green. **Remaining lag is intrinsic** (Windows ConPTY full-frame redraw cost + occasional
synchronous core ops in the dispatch path — `safeAddEpisode` SQLite writes, `buildIndex`/`writeIndex`
workspace re-index; candidates for a worker-thread offload later).

### P1 slice 7 — TUI crash resilience: never eject to the shell (2026-05-30)
**Reported bug:** mid-session the TUI sometimes "falls out" — a real shell prompt appears right
under the chat frame; you can still type, but input goes to the shell and errors. = the TUI
**process exited unexpectedly**, leaving the last alt-screen frame over a live shell.
**Three independent eject paths, all closed:**
1. **`terminal/screen.ts` global handlers were fatal.** `uncaughtException`/`unhandledRejection`
   both did `cleanup()` (leave alt screen) + `process.exit(1)`. In an async-heavy runtime a *single*
   stray rejection (MCP, memory write, aborted fetch, a forgotten `.catch`) ejected the user. Now
   **non-fatal**: `reportRuntimeError()` logs to `.agency/crash.log` + surfaces a banner via a new
   `onAgencyRuntimeError` global hook (registered in `App.tsx`, like `onAgencyEventBusError`), and
   **stays in the alt screen, never exits**. Identical errors throttled (1s) so a loop can't spam.
   SIGINT/SIGTERM + normal Ink exit still restore the terminal cleanly.
2. **React render throw → silent exit.** An uncaught render error unmounts the App → Ink
   `waitUntilExit()` resolves → the launcher leaves the alt screen and `process.exit(0)`s. New
   `components/AppErrorBoundary.tsx` wraps the whole tree (outermost, in `index.ts`): renders a calm
   fallback, auto-retries 3× (transient render races self-heal), then holds the fallback so the user
   can read it and Ctrl+C out — **always still inside the TUI**.
3. **`EventBus.publish` could reject.** `JSON.stringify` on a circular/BigInt payload throws → a
   `void eventBus.publish(...)` becomes an unhandled rejection (→ path 1). `publish` now guards
   stringify and degrades to a safe string; **it never rejects**.
**Tests:** `error-boundary.test.tsx` (+2: throwing child → fallback, not unmount; healthy passthrough),
`event-bus.test.ts` (+1: circular payload → resolves, never rejects). Verified: full `pnpm -r build`
clean, core **304** green, tui **115** green.

### Tests added
`core/src/__tests__/p0-hardening.test.ts`, `mcp-approval.test.ts`, `event-attribution-handover.test.ts`;
`tooling/src/__tests__/invoke-safe.test.ts`; `memory/src/__tests__/lifecycle-manager.test.ts`;
additions to `governance/src/__tests__/governance.test.ts`.

---

## 4. Flag reference (current)

| Env var | Default (legacy / hardened) | Effect |
|---|---|---|
| `AGENCY_PROFILE` | `legacy` | master switch for the defaults below |
| `AGENCY_PERSIST_EVENTS` | on / on | mirror EventBus → SQLite journal |
| `AGENCY_AUTO_RECOVER` | off / on | discovery **and** auto-resume of crashed tasks (crash-loop guarded) |
| `AGENCY_APPROVAL_IN_TOOLPATH` | warn / enforce | gate write/destructive/MCP tools |
| `AGENCY_DELEGATION_GUARDS` | on / on | depth/hop/cycle ceilings |
| `AGENCY_MAX_DEPTH` / `AGENCY_MAX_HOPS` | 8 / 12 | delegation ceilings |
| `AGENCY_EXECUTION_BUDGET_MS` | 0 / 300000 | per-agent wall-clock deadline (0=off) |
| `AGENCY_MAX_PARALLEL_AGENTS` | 3 | parallel dispatch concurrency |
| `AGENCY_MEMORY_GC` | off / on | startup GC/dedup/quota pass |
| `AGENCY_MEMORY_MAX_EPISODES` / `_VECTORS` | 50000 | row quotas |
| `AGENCY_MEMORY_SEMANTIC` | off / on | embed episodes (local deterministic embedder) on persist + recall via HybridRetriever (vector + FTS RRF + recency); off = keyword FTS + recency only |
| `AGENCY_MCP_REQUEST_TIMEOUT_MS` | 30000 | JSON-RPC request timeout |
| `AGENCY_MAX_CRASH_LOOPS` | 3 | auto-resume crash-loop ceiling (abandon task after N failed resumes) |
| `AGENCY_CAPABILITY_ROUTING` | off / on | capability-driven agent rerouting |
| `AGENCY_CHECKPOINT_STRICT` | warn / reject | reject (vs warn+load) a checkpoint whose checksum mismatches |
| `AGENCY_ATOMIC_ROLLBACK` | off / on | journaled multi-file commit + startup rollback of half-applied commits |
| `AGENCY_SECRET_SCAN` | off / on | on persist: redact secrets in episodes, quarantine secret-bearing vectors |
| `AGENCY_VERIFY_LOOP` | off / on | wrap a subagent edit in an outer verify→self-correct loop |
| `AGENCY_VERIFY_MAIN_TURN` | =verifyLoop | also verify→self-correct the MAIN chat turn (one-shot CLI only; not the TUI) |
| `AGENCY_VERIFY_MAX_ROUNDS` | 3 | max attempts in the verify loop (when on) |
| `AGENCY_VERIFY_LINT` | off / on | add `lint` to the verify-loop acceptance (when a lint script exists) |
| `AGENCY_VERIFY_TESTS` | off / off | add `test` to acceptance (opt-in — full suite is slow) |
| `AGENCY_MODEL_CATALOG` | off / on | use `models.json` for accurate per-model limits/cost/capabilities |
| `AGENCY_MODELS_JSON` | (auto-located) | explicit path to the model catalog (else env→walk-up→cwd) |
| `AGENCY_CONTEXT_COMPACTION` | off / on | §2.3 — summarize the middle of a long history before it overflows the context window (keeps system + last 4 turns) |
| `AGENCY_TRACE_RECORD` | off / off | §2.5 — record a per-session behaviour trace (turn timings + tool I/O) to `.agency/traces/` (opt-in; per-tool overhead) |
| `AGENCY_COGNITION_STREAM` | off / on | emit `thought:emitted` narration (routing + safety decisions) for the TUI CognitionPanel (which already subscribes); gated centrally in `emitThought` |

**27 flags total** (added `memorySemantic`/`AGENCY_MEMORY_SEMANTIC` — wires the dormant HybridRetriever + local embedder). All resolve via `getRuntimeFlags()` (env override → `AGENCY_PROFILE` default → built-in).

Inspect any time with `agency status` / `agency status --json`.

---

## 5. What's NEXT (priority order — pick the top item)

> **LATEST (2026-05-31, cont'd) — git history established, verify gate, compaction wired, dead-machinery audited.**
> - **Git:** repo had ZERO commits; now `0d216b9`(init) → `656498d`(memory observability fix) → `1cb58c1`(verify gate) → `b9f33e9`(§2.3 compaction). Tree clean. See §6.
> - **Verify gate:** `pnpm verify` (build+test all 16 pkgs) + CI workflow. **The rule now: run `pnpm verify` before claiming green** — directly cures this repo's recurring false-green handoffs.
> - **Memory observability:** `safeAddEpisode` no longer silently drops a failed episode write — it emits a `system:warning` (same class as the `loadCheckpoint` corrupt-swallow fix).
> - **§2.3 context compaction WIRED:** the `summarizeHistory` machinery was built-but-unwired (0 call sites) **and** coded against a phantom provider API. Now one shared `compactTurnHistory` (turn-helpers.ts) runs in BOTH `runChatTurn` + `runChatTurnWithStream`, gated by `AGENCY_CONTEXT_COMPACTION`; `summarizeHistory` delegates to it (dedup + bugfix).
> - **WIRED-OR-DEAD AUDIT (the initiative's core thesis, made explicit).** Swept every machinery class exported from `core/index.ts`. **Confirmed WIRED:** `ApprovalPolicyEngine` (tool-harness), `CapabilityAgentRegistry`/`capabilityRegistry` (dispatch), `RuntimePressureController` (static, runner.ts), `ToolRegistry`, cost governor/supervisor, `LeaseManager`, **`OutputEngine`** (cli `out`/`handleError` — corrected 2026-05-31 cont'd 3, was mislabeled dead below). **Confirmed DEAD (built + exported + tested, but NO live code imports the module):**
>
> | Dead module | Disposition |
> |---|---|
> | ~~`DomainSpecialistRegistry` (agents/specialist-registry.ts)~~ | superseded by `CapabilityAgentRegistry` → **DELETED** (dead duplicate; `.agency/specialists/*.json` override was never wired — recover from `0d216b9` if ever wanted) |
> | ~~`SessionConversationManager` (chat/session-conversation.ts)~~ | compaction lives in `compactTurnHistory`; JSONL persistence duplicated by TUI's live `sessions/store.ts` → **DELETED** (dead duplicate) |
> | ~~`PlannerEngine` (planner/planner-engine.ts)~~ | duplicate DAG executor (own `ExecutionDagContract` model); live plan execution is `runPlan`/`task/runner.ts` (+ `ConvergenceEngine`, `detectDagCycle`, checkpoints) → **DELETED** (dead duplicate) |
> | ~~`SkillsRegistry` (skill/skills-registry.ts)~~ | in-memory skill registry duplicates skills-bridge; its per-skill circuit-breaker overlaps the wired tool-loop breaker (`chat/circuit-breaker.ts`) → **DELETED** (dead duplicate) |
> | ~~`OutputEngine` (+ formatters, output/)~~ | **AUDIT MISLABEL — actually WIRED, not dead.** `cli/src/utils.ts` `out = OutputEngine.shared()` + `handleError()` → **49 `out.*`/`handleError` calls across 12 command files.** Moved to WIRED list above; NOT deleted. |
> | ~~`LongRunnerManager` (task/long-runner-manager.ts)~~ | **DELETED (2026-05-31 cont'd 5).** Its concerns are already live: per-task heartbeat + stall→fail via the wired `LeaseManager` (runner.ts `acquireLease`/`renewLease`/`checkExpired`), SIGINT/SIGTERM graceful-shutdown in 4 live places (tui screen.ts, tui index.ts, security/sandbox.ts, browser/runtime.ts), and crash-resume via checkpoint.ts + auto-resume. Its `runners.jsonl` had 0 live consumers and the detached cross-process runner model it targeted does not exist. A real tier-6 detached-ops feature should be designed fresh on `LeaseManager` (recover from `0d216b9`). |
> | ~~`ReplayEngine` (events/replay-engine.ts)~~ | **NOW WIRED (2026-05-31 cont'd 4):** `verifyJournalReplay`/`replaySessionJournal` + the `agency replay` command verify the durable journal hasn't diverged/corrupted (§2.5 behaviour-replay *foundation*). No longer dead. |
>
> The remaining live-but-unwired modules are **left in place + documented** (not mass-deleted/wired in one pass — several need design decisions, one is planned). Picking any single one to wire-or-delete is a clean next slice.
>
> **wire-or-delete slice DONE (2026-05-31, cont'd 2):** the two confirmed-replaced dead duplicates above — `DomainSpecialistRegistry` and `SessionConversationManager` (+ their tests + `core/index.ts` exports) — were **deleted**. Verified by grep (only their own tests + the index re-export imported them; no live/CLI/TUI consumer) then `pnpm verify` green. Core 350→**344**, repo ~2001→**1995** tests (−6 = the two test files).
>
> **wire-or-delete slice 2 DONE (2026-05-31, cont'd 3):** swept the next batch with the "no duplication" lens. **`OutputEngine` was an audit MISLABEL — it is WIRED** (cli `out`/`handleError`, 49 calls/12 files) → kept + moved to WIRED, docs corrected. **`PlannerEngine` and `SkillsRegistry`** were confirmed dead duplicates (PlannerEngine ↔ live `runPlan`/`runner.ts`; SkillsRegistry ↔ live skills-bridge + `chat/circuit-breaker.ts`) → **deleted** (+ tests + `core/index.ts` exports). Verified by grep (no live importer, incl. the `cli/commands/skill.ts` `registerSkill` name-collision being unrelated) then `pnpm verify` green: core 344→**336**, repo 1995→**1987** (−8 = the two test files). **`LongRunnerManager` kept** (tier-6 wire-target, no live duplicate); `ReplayEngine` stays for §2.5. Dead-module list is now empty except those two intentional keeps.
>
> **§2.5 ReplayEngine WIRED (2026-05-31, cont'd 4):** the last unwired keep is now wired without duplicating the existing journal infra. New core primitive `verifyJournalReplay(events)` (reuses the `ReplayEngine` class — no second hash impl) + `replaySessionJournal(projectRoot)` (loads the durable journal via `EventJournal.readEvents()`) + the **`agency replay [--json]`** command. It replays the recorded `.agency/events/journal.db` and flags any event whose stored payload no longer hashes to its stored `payloadHash` (on-disk corruption/tampering — same "make corruption observable" family as the checkpoint-integrity fix). **Correctness detail:** EventBus hashes oversized payloads over the *original* but stores a small spill-ref inline, so a naive replay would false-positive — `verifyJournalReplay` detects spill-refs and reports them as `skipped` (honest coverage), never as failures. Purely additive (new command; no existing path changes → legacy ≡ hardened, no flag). Tests: `replay-journal.test.ts` (+6) + `cli/replay.test.ts` (+3, incl. tamper→exit 1). `pnpm verify` green: core 336→**342**, cli 547→**550**, repo 1987→**1996**. This is the §2.5 *foundation* (verification primitive + surface); full record/replay behaviour-regression (deterministic re-execution + recorded LLM responses) reuses this primitive and is the follow-up. **Only `LongRunnerManager` (tier-6) remains unwired now.**
>
> **WIRED-OR-DEAD INITIATIVE CLOSED 100% (2026-05-31, cont'd 5):** the last limbo module, `LongRunnerManager`, was **deleted** as a dead duplicate (+ test + `core/index.ts` export) after confirming every concern of it is already live: heartbeat + stall→fail via the wired `LeaseManager` (runner.ts `acquireLease`/`renewLease`/`checkExpired`, 5s renew), SIGINT/SIGTERM graceful-shutdown in 4 live places, crash-resume via checkpoint.ts + auto-resume; `runners.jsonl` had 0 consumers and its detached cross-process runner model doesn't exist. `pnpm verify` green: core 342→**340**, repo 1996→**1994** (−2). **Every machinery class exported from `core/index.ts` is now either WIRED or DELETED — zero "built-but-unwired" limbo remains.** Final tally: deleted 5 dead duplicates (DomainSpecialist, SessionConversation, Planner, Skills, LongRunner), wired 1 (ReplayEngine §2.5), corrected 1 mislabel (OutputEngine was always wired).
>
> **§2.4 stronger tool layer — mostly already present (2026-05-31, cont'd 6):** audited the three §2.4 items. (1) **Precise diff/patch editing WIRED:** `ast-compiler` (real TS AST, `utils/`) was only used lightly in `approval-policy-engine` risk-sim and was NOT a model tool — now exposed as the **`ast_edit`** tool (rename_symbol / replace_function_body / replace_method_body / modify_import / delete_node / insert_function), reusing the ast-compiler functions verbatim (no dup), auto-advertised via `registry.listTools()`→`buildSystemPrompt`, approval-gated. (2) **Parallel tools already done + verified safe:** both turn paths `Promise.all` the tool batch; file-writing handlers are synchronous read-modify-write with no `await` between → atomic on Node's single thread → no race, so "serialize dependent" would fix a non-bug. (3) **Smart truncation already present** (`truncateToolResult` scales to the model context window). Also consolidated the duplicated `filesWritten` detection (orchestrator+stream) into `isFileWritingTool`. `pnpm verify` green: core 340→**345** (+5), repo 1994→**1999**.
>
> **§2.5 record producer WIRED (2026-05-31, cont'd 7):** the behaviour-replay record/replay machinery already existed but had no live trace producer — `telemetry` `ActiveTelemetryTracker` (records turn timings + tool I/O → `DeterministicExecutionTrace`) + telemetry `ReplayEngine` (`interceptToolCall` fuzzy-matches recorded outputs, throws on drift) + `benchmark.runRegressionReplay` were all built + tested, but nothing recorded a real session. Wired `SessionTraceRecorder`/`createTraceRecorder` (`chat/trace-recorder.ts`, REUSES `ActiveTelemetryTracker` — no new tracker) into BOTH turn paths via null-safe hooks (recordTool after each `executeTool`, recordTurn+save at turn end) → writes `.agency/traces/<sessionId>.json`. Flag `AGENCY_TRACE_RECORD` opt-in (off both profiles — per-tool overhead; off ⇒ recorder null ⇒ byte-identical). core gained a dep on `@agency/telemetry` (zero-dep leaf → no cycle). Also fixed a boundary-flaky `prompt-bridge` Python-router test (4.7s on a 5s default limit → tipped over under concurrent load; widened to 20s). `pnpm verify` green: core 345→**348** (+3), repo 1999→**2002**.
>
> **§2.5 replay-regression driver WIRED (2026-06-01, cont'd 8):** the last unwired half of §2.5 — `benchmark.runRegressionReplay` had no live caller outside tests. Added the **`agency replay-regression [trace]`** command (`cli/commands/replay-regression.ts`) that drives `runRegressionReplay` + `loadTraceFile` (reused verbatim — no new replay/hash logic) over recorded `.agency/traces/` files. Two modes: **validate** (single trace → confirm it's well-formed + fully replay-ready; surfaces corrupt/partial/non-trace files) and **regression** (`--baseline <ref>` → replay the candidate's recorded tool-call sequence against the baseline's recorded outputs; a baseline-absent tool call `[Replay Deviation]` or an unconsumed baseline output = drift → exit≠0). Needs **no LLM responses** (both runs already on disk) — the no-key deliverable. `--list` lists traces. Purely additive (new command → legacy ≡ hardened → no flag). cli declares `@agency/telemetry` (zero-dep leaf, no cycle) so tsc resolves the trace type while the executor type is derived structurally from `runRegressionReplay`. Boundary guard: trace shape is pre-validated before `runRegressionReplay` (whose own catch calls `getUnconsumedCount()`→`toolOutputs.length`, which would itself throw on a malformed trace). Tests: `cli/replay-regression.test.ts` (+6: list / validate / non-trace-fail / match / drift / deviation). `pnpm verify` green: cli 550→**556**, repo ~2002→**2008**.
>
> **Wired-or-dead audit EXTENDED beyond `core/index.ts` (2026-06-01, cont'd 9).** The prior audit only swept `core/index.ts` *exports*; a full `core/src` sweep (every source file, importers checked across `.ts`/`.tsx`/`.mts` — the `.tsx` step matters: it caught `tui/state/semantic-orchestration.ts` as **live via `App.tsx`**, a false "dead" under a `.ts`-only grep) found **3 non-exported modules with no live importer**: (1) `events/cognition.ts` — NOT dead, a **live-consumer/dead-producer** gap (`App.tsx` subscribes to `thought:emitted` for the CognitionPanel, but `emitThought` had 0 runtime callers → panel always empty) → **wired** (see cont'd 10); (2) `skill/context-delivery.ts` (358 lines, adaptive context tiers) + (3) `validation/correctness-science.ts` (436 lines, chaos/invariant harness) — both fully unit-tested but with **zero live consumer** and not in any index → confirmed speculative limbo → **DELETED** (+ their isolated tests `context-delivery.test.ts` / `runtime-correctness.test.ts`; recoverable from `0d216b9`). Verified: `pnpm verify` green, build 16/16, core 348→**328** (−20 = the 8+12 deleted tests), repo ~2008→**1988**.
>
> **Cognition producer WIRED — live consumer was starved (2026-06-01, cont'd 10).** The third unwired module from the cont'd 9 sweep, `events/cognition.ts`, was a **live-consumer/dead-producer** gap (same class as §2.5): `App.tsx:550` subscribes to `thought:emitted` (drives the CognitionPanel + heartbeat) but `emitThought` — the only publisher — had **zero runtime callers**, so the panel was permanently empty. Wired `emitThought` at two high-signal decision points, reusing the live bus + consumer (no new machinery): (1) **routing** in the shared `resolveRoute` (`chat/turn-helpers.ts`, fresh-resolve only — DRY home for both turn paths) → `planner`/`planning` thought; (2) **safety gating** in the tool-harness approval hook (warn + enforce branches) → `risk-engine`/`editing` thought (separate channel from the existing `approval:*` audit events — narration, not duplication). Gated centrally inside `emitThought` by the new flag `AGENCY_COGNITION_STREAM` (off legacy ⇒ no extra bus events ⇒ byte-identical; on hardened), so call sites stay unconditional. `agency status` shows the flag. Tests: `cognition-stream.test.ts` rewritten (+1: emits-when-on / no-op-when-off). `pnpm verify` green: core 328→**329**, repo ~1988→**1989**, **26 flags**.
>
> **More cognition emit points WIRED (2026-06-01, cont'd 11).** Extended the single `emitThought` producer to the three remaining high-signal decision points the prior NEXT called out — reusing the live bus + consumer, no new machinery, no duplication, all gated centrally in `emitThought` (off legacy ⇒ byte-identical): (1) **capability reroute** in `dispatchAgent` (next to the existing `subagent:routed` publish) → `scheduler`/`planning`/`adaptation`; (2) **verify self-heal** via a new shared helper `emitVerifyRoundThought` (`events/cognition.ts`) bound to `runVerifyLoop`'s `onRound` hook at ALL THREE verify sites (dispatchAgent SEARCH/REPLACE + XML tool-call paths + the main-turn `verifyAndHeal`) → `validator`/`validation`/`adaptation`, narrating only a *failed* round (the terminal pass/fail is already carried by lifecycle events); (3) **context compaction** in `compactTurnHistory` (next to the existing `system:warning`) → `retrieval`/`retrieval`/`adaptation`. The `onRound` wiring is purely additive (those `runVerifyLoop` calls passed only `{ maxRounds }` before). The shared helper keeps the verify narration in one place rather than copy-pasted across the three sites. Tests: `cognition-stream.test.ts` (+3: failed-round narrates / passed-round silent / no-op when flag off). `pnpm verify` green (build 16/16, exit 0): core 329→**332**, repo ~1989→**1992**. **26 flags** (no new flag — reuses `cognitionStream`).
>
> **Harness / built-in tools / skills audited + integrity guard (2026-06-01, cont'd 12).** Per the user's ask ("ensure the harness is correct + skills/built-in tools complete + no duplication, and document the source so it isn't re-derived"), audited all three layers from real source (no assumptions): **harness** — `resolveRoute`→`buildSystemPrompt`(tools advertised dynamically from `registry.listTools()`)→outer tool loop (`parseToolCalls` XML → `Promise.all` execute → result fed back)→verify/self-heal→compaction; sound. **Built-in tools** — 17 in **one** `ToolRegistry` (no second table), all auto-advertised; `grep_file` (single file) vs `grep_search` (recursive, ignore-aware) are distinct scopes, **not** a duplicate (recorded in the near-duplicates table). **Skills** — `packages/cli/skills/` manifest declares 28 skills + 8 agents + 8 workflows; a precise diff found **zero drift** (manifest 28 ↔ disk 28, `manifest.agents` == `MANIFEST_AGENTS`, no orphans either way). The gap was that **nothing guarded this** — so it could silently rot (a SKILL.md without a manifest entry = built-but-unwired; a manifest entry without a SKILL.md = advertised-but-missing — the initiative's exact defect class). Added `cli/__tests__/skills-manifest-integrity.test.ts` (+5: manifest-skill→SKILL.md exists / on-disk→declared / agents==MANIFEST_AGENTS / load_order references declared skills), reusing the real loaders (`loadManifestSkills`, `skillMdPath`) + `MANIFEST_AGENTS` — lives in cli because core depends on skills-bridge (can't import `MANIFEST_AGENTS` there). Documented the full harness/tools/skills inventory in PACKAGES.md so it isn't re-derived. Purely additive (new test + docs, no flag). `pnpm verify` green (build 16/16, exit 0): cli 556→**561**, repo ~1992→**1997**.
>
> **Agent dispatch-space integrity guard (2026-06-01, cont'd 13).** Continued the completeness audit one layer up from skills: the agent dispatch space. Confirmed from real source that all 8 `MANIFEST_AGENTS` are fully wired — each has an `AGENT_SUBAGENT_PROMPT` mapping (`implementer-prompt.md` ×7 / `code-quality-reviewer-prompt.md` for `security-auditor`, both exist on disk; `spec-reviewer-prompt.md` is an unmapped optional template, not a bug), a capability seed in `AGENT_SEEDS`/`capabilityRegistry`, and discipline skills that are all declared manifest skills — **zero drift**. The same unguarded gap as skills (add a 9th agent, forget the prompt mapping or the seed ⇒ silent dispatch degradation). Added `core/__tests__/agent-dispatch-integrity.test.ts` (+5: prompt-map keys == MANIFEST_AGENTS / seed ids == MANIFEST_AGENTS / each prompt template resolves on disk via `subagentPromptPath` / disciplines are declared skills), reusing the core config maps + `capabilityRegistry.snapshot()` + `loadManifestSkills` (no new exports; lives in core since all config is core-local and core deps skills-bridge). Documented the agent dispatch space in PACKAGES.md. Purely additive (test + docs, no flag). `pnpm verify` green (build 16/16, exit 0): core 332→**337**, repo ~1997→**2002**.
>
> **`agency status` flag-view completeness — observability gap closed (2026-06-01, cont'd 14).** Continued the completeness audit to the flag layer, the load-bearing mechanism of the whole initiative ("every behaviour change is gated by a flag"). Grepped every flag for a live behaviour-gating consumer: **all 26 are wired** (no dead toggle), but the **human `agency status` hand-picked ~14 of them and silently omitted 6 behaviour-changing/operational flags** — `mcpRequestTimeoutMs`, `checkpointStrict`, `atomicRollback`, `secretScan`, `verifyMainTurn`, `traceRecord` (plus the `maxCrashLoops` tunable). So `AGENCY_PROFILE=hardened agency status` showed neither secret-scan, atomic-rollback, nor checkpoint-strict as active even though they were — "wired but not observable". (The `--json` path already emitted the full `getRuntimeFlags()` object — only the human view was incomplete.) Refactored the flag block into a single declarative `buildFlagRows(flags)` (each row declares the flag keys it covers; `printHuman` just renders it — removes the hand-pick divergence risk) and added the missing rows. Guard: `cli/__tests__/status-flags.test.ts` (+3) asserts the union of covered keys == every `getRuntimeFlags()` key, so a new flag can't be added without surfacing it. Verified the real output: hardened now shows Secret scan / Atomic rollback / Checkpoint strict on, MCP timeout, Trace record, Auto-recover crash-loop ceiling, Verify loop "+main-turn". Purely additive (display + test, no flag, no runtime behaviour change). `pnpm verify` green (build 16/16, exit 0): cli 561→**564**, repo ~2002→**2005**.
>
> **Duplication sweep widened to types/consts + `ChatMessage` consolidated (2026-06-01, cont'd 15).** Extended the repeatable scan beyond function/class names (which only ever matched the intentional `ReplayEngine` pair) to **exported consts** (zero matches) and **exported type/interface names** (5 matches). Classified each from source: `ToolCall` (core parsed-XML `{name,arguments:string}` vs tooling registry `{id,name,arguments:any}`), `GraphEdge` (code-dependency graph vs memory knowledge graph), `VerificationResult` (tool-harness command result vs checkpoint task record), `AuditEntry` (approval-gate line vs memory mutation row) are all **genuinely distinct** → documented in the near-duplicates table (kept). The one **real duplicate**: `ChatMessage` (`{role, content}`) was byte-identical in `core/chat/orchestrator.ts` and `providers/types.ts`, and core already deps providers → made `@agency/providers` the sole owner and re-exported it from `orchestrator.ts` (`import type` + `export type { ChatMessage }`), so the `prompt.ts`/`turn-helpers.ts` consumers keep one import path with a single definition (removes the silent-divergence risk). Behaviour-preserving (type-only). `pnpm verify` green (build 16/16, exit 0); counts unchanged (core 337, cli 564, ~2005). Also documented the type/const scan variants in PACKAGES.md so the next sweep is one command.
>
> **`agency doctor` runtime skills-pack integrity (2026-06-01, cont'd 16).** The CI guards (cont'd 12/13) validate the *bundled* pack we ship; `agency doctor` validates the *installed* pack on the user's machine (or a custom `AGENCY_SKILLS_ROOT`) — but it only checked that the manifest *file existed*, so a partial/corrupt install reported `skills-pack ✓` and then failed at runtime when a declared-but-missing skill was invoked. Enriched the check to load the manifest and verify **every declared skill resolves to a real `SKILL.md`** (reusing `loadManifestSkills` + `skillMdPath` — the same loaders, no new logic; self-relative so a minimal custom pack that is internally consistent still passes). Manifest unreadable/not-JSON → `fail` (was a silent crash path); declared-but-missing SKILL.md → `fail` with the names; all present → `ok (N skills)`. Complementary to the CI test (runtime/installed vs build/bundled), not a duplicate. Test: `doctor.test.ts` (+1: integrity passes on the consistent fixture, detail reports the skill count). Verified real output: `skills-pack ✓ …\skills (28 skills)`. Purely additive. `pnpm verify` green (build 16/16, exit 0): cli 564→**565**, repo ~2005→**2006**.
>
> **BYOK eval run — verify-loop self-heals a real model mistake END-TO-END (2026-06-01, cont'd 17).** Ran the legacy↔hardened comparison on a real provider (NVIDIA NIM `minimaxai/minimax-m2.7`). Refreshed 4-task hard suite reproduced the **ceiling effect** (legacy 4/4 · hardened 4/4 · both avg 1.0 rounds · gate PASS) — minimax one-shots that corpus, so the loop never fired. **Then added `hard-merge-intervals`**, a *counter-conventional* discriminator (overlapping intervals merge, but ones that merely TOUCH must NOT — correct needs strict `<`, the universal `<=` fails exactly the touch cases; overriding that training prior trips attempt-1). On the 5-task run: legacy 5/5 (avg 1.0) · hardened 5/5 (**avg 1.2**) — and `hard-merge-intervals` recorded **rounds=2 in hardened**: attempt 1 failed the acceptance test, the failing `test.cjs` output was fed back, attempt 2 passed. **This is the first end-to-end evidence the production verify-loop self-heals a live-model failure** (every prior run was avg 1.0 — the loop never had a failing round). Success *rate* stayed equal (the loop recovered the miss; the model is non-deterministic and one-shot the same task in legacy) — the **rounds telemetry** is the proof, complementing the mocked integration tests. Full methodology + numbers in [EVAL_RESULTS.md](EVAL_RESULTS.md). **Key handled securely: never written to disk** — config's `nvidia.apiKey` was temporarily swapped to the `${NVIDIA_API_KEY}` placeholder (backed up, restored via a `trap` on exit), the real key passed only via env per-command. Corpus task added to `@agency/benchmark` (data, not a test — counts unchanged). `pnpm verify` green (build 16/16, exit 0).
>
> **§2.5 LLM-response recording WIRED — the trace's missing half (2026-06-01, cont'd 18).** The §2.5 record producer (cont'd 7) captured tool I/O + turn timings but **not the model's completions**, so a recorded trace could replay *what the harness did with the words* but not *the words themselves* — the prior NEXT's "full §2.5 needs recording LLM responses too". Closed by extending the existing machinery, **no new module/flag**: (1) `DeterministicExecutionTrace` gained an **optional** `llmResponses?: LlmResponseEntry[]` (optional ⇒ pre-§2.5 traces still load and replay; every existing consumer ignores it) + `TelemetryTracker.recordLlmResponse`; (2) `ActiveTelemetryTracker` records them, `ReplayEngine` gained `interceptLlmResponse(text)` (positional content-match — the §2.5 analogue of the arg-matched `interceptToolCall`; LLM responses are ordered by turn, not keyed by args) + `getUnconsumedLlmCount()`, normalizing a missing array to `[]`; (3) `SessionTraceRecorder.recordLlmResponse` wired into BOTH turn paths right after `llmText += currentText` (orchestrator + stream) — null recorder when `AGENCY_TRACE_RECORD` is off ⇒ byte-identical; (4) `benchmark.runRegressionReplay` + the **`agency replay-regression`** driver now reproduce + verify the completion sequence too (a diverging/extra/missing response ⇒ `[Replay Deviation]`/unconsumed ⇒ exit≠0; `ReplayRegressionResult.unconsumedLlmResponses` added). The trace already carried `providerSeed` for exactly this — a seeded/deterministic re-run should reproduce the same completions, a real behaviour-regression signal (and a non-deterministic re-run surfacing a different response *is* a behaviour difference the driver is meant to flag). Tests extended in place (no new files): `telemetry.test.ts` (4→9), `benchmark.test.ts` (14→18), `cli/replay-regression.test.ts` (+3), `core/trace-recorder.test.ts` (LLM round-trip). `pnpm verify` green (build 16/16, exit 0): telemetry 4→**9**, benchmark 14→**18**, cli 565→**568**, repo ~2006→**~2018**. **26 flags** (no new flag). This makes the recorded LLM data *used immediately* (consumed/verified by the live driver — not built-but-unwired); the remaining full-§2.5 step is live re-execution via a `ReplayProvider`.
>
> **Memory professionalism pass — recall, semantic engine, compaction (2026-06-01, cont'd 19).** A review of memory across sessions / long context / compaction found the machinery professional but the *live recall* amateur and the flagship engine dormant. Three slices, each `pnpm verify`-green + committed:
> - **`0fe6371` — CLI cross-session recall was dead + leaky SQL.** `resolveSessionId` fell back to the constant `"sess-cli"` for every headless run, but `loadHistoricalMemories` filters recall by `session_id != current` → every prior CLI episode was excluded; the agent never recalled its own past runs. Fixed with a shared `resolveSessionId` (unique-per-process id; explicit/`AGENCY_SESSION_ID` still win; TUI unaffected). Also replaced the raw `(db as any).db` recency SQL with a typed `recentEpisodesAcrossSessions`/`getRecentAcrossSessions`, and bounded the recall block by a char budget. (memory 34→35, core 337→340.)
> - **`ffd0ae8` — wired the dormant `HybridRetriever` + a local embedder.** The `HybridRetriever` (semantic vector + FTS reciprocal-rank fusion, recency/task/file boosting, token-budget packing) had **zero live consumers** — the signature built-but-unwired defect on the flagship recall engine — because nothing generated embeddings. New `LocalDeterministicEmbedder` (feature-hashing, no network/key/model file, reproducible → preserves eval/replay determinism a provider embedder would break; behind an `Embedder` interface for a future provider swap). `safeAddEpisode` now embeds episodes into vectors and `loadHistoricalMemories` recalls via the HybridRetriever (+ recency) when on; `HybridRetriever` now exposes `source` (richest matched record) generically so the caller keeps episode-rich formatting without coupling the retriever to `Episode`. Flag `AGENCY_MEMORY_SEMANTIC` (off legacy = keyword FTS + recency, byte-identical / on hardened); surfaced in `agency status` + covered by the status-flags guard. (memory 35→36, core 340→342, **27 flags**.)
> - **`b42e82d` — compaction can no longer overflow its own summarizer.** §2.3 summarized the whole middle in one call; for a long task that prompt could itself exceed the window. `summarizeMiddle` now bounds every call to `maxInputChars` (default 8000) — one call when it fits, else chunked + hierarchically combined (bounded). Unchanged for the common small case; never throws. (core 342→343.) *Follow-up:* cross-turn running-summary (only re-summarize new turns) needs session-history threading; the reactive context-limit handler stays the mid-loop net.
>
> `pnpm verify` green throughout (build 16/16, exit 0): repo ~2018→**~2026**, **27 flags**.
>
> **§2.5 re-execution + cross-turn running-summary (2026-06-01, cont'd 20).** Closed the two no-key follow-ups the cont'd-19 NEXT named:
> - **`20021fb` — §2.5 re-execution (safe core).** With completions now recorded (cont'd 18), `agency replay-regression --reexecute` re-derives the tool-call sequence from a trace's recorded completions using the REAL `parseToolCalls` and asserts it matches the tools that actually ran (`toolOutputs`); a parser/dispatch regression surfaces as drift (exit 1). Deterministic + side-effect-free (no tools/gate/episode writes) — reuses `parseToolCalls`, no dup. A full live re-run through a `ReplayProvider` would additionally need to intercept tool execution + the gate + episode writes (higher-surface) — documented as the remaining option, not built. (cli 568→571, +3.)
> - **`19cf875` — cross-turn running summary.** `compactTurnHistory` takes a `cacheKey` (session id); when a later turn's middle merely extends an already-summarized one it summarizes only the NEW turns folded into the prior summary — O(new) not O(all) summarizer cost across a long session. Prefix-validated per scope (can't serve a stale/diverged summary); no cacheKey ⇒ no caching ⇒ byte-identical for non-opted-in callers. Both turn paths pass `resolveSessionId`. (core 343→344, +1.)
>
> `pnpm verify` green (build 16/16, exit 0): repo ~2026→**~2030**, **27 flags** (no new flag). **§2.5 is now closed end-to-end** (foundation `42d8446` → record producer `f38400e` → replay-regression driver `76ad15e` → LLM-response recording `576089a` → re-execution `20021fb`); compaction is bounded + chunked + incremental.
>
> **NEXT (the buildable no-key backlog is now empty):** **promote `hardened`→default** — the campaign's end-goal, but it flips many behaviour defaults for every user, so it needs (a) a clean BYOK eval delta (legacy↔hardened on a corpus the model doesn't one-shot) and (b) an explicit go-ahead; do NOT flip the default autonomously · optional §2.4 typed/structured tool results — **deliberately deferred**: tool results already truncate intelligently and the LLM consumes text, so typing them is high-surface for marginal gain · a full live `ReplayProvider` re-run (high-surface, see above).

> **STATUS (2026-05-30):** (A)·(B)·(C)·(D)·(E)·(F) all DONE → **every audit hardening gap is closed.**
> Maturity tier 1 + tier 2 complete + 3 TUI reliability fixes. **Eval harness (ROADMAP Phần 3) STARTED:**
> `packages/benchmark` now has an `execute` step + `aggregateResults` + `gateAgainstBaseline` + the
> **`agency eval`** command (verified e2e). **Verify loop (ROADMAP Phần 2.1) STARTED:** `runVerifyLoop`
> engine (completion + no-progress + budget detection) wired into `dispatchAgent` (`AGENCY_VERIFY_LOOP`) —
> re-runs the agent on a verification failure with the errors fed back; legacy = single attempt. Acceptance
> widened from build-only → **build + lint + (opt-in) test** (`buildAcceptanceCommands`), and the loop now
> covers **both** edit paths (SEARCH/REPLACE staging *and* XML tool-call writes via `validateWithHeal`).
> **Model catalog (BYOK) wired:** `models.json` (~5k models) now feeds accurate per-model
> limits/cost/capabilities via `getModelSpec` enrichment + the cost governor (`AGENCY_MODEL_CATALOG`);
> the shared `matchModelKey` deduplicates the registry/catalog matchers. Cost is now real (e.g. opus-4-5
> = $30/Mtok-pair, not the old wrong $90).
>
> **UPDATE (2026-05-31) — the eval now actually exercises the verify-loop.** Three blockers that made a
> legacy↔hardened comparison meaningless were closed:
> 1. **Critical path fix.** The production verify-loop only wraps `dispatchAgent` (SUBAGENT dispatches),
>    **not** the main turn `runChatTurnWithStream` — and `agency eval --agent` calls `runChatTurnWithStream`,
>    so the old eval never ran the loop at all (legacy ≡ hardened except for the approval gate). Worse, the
>    dispatchAgent loop accepts on `npm run build`, which a bare `.cjs` corpus task doesn't have. **Fix:**
>    `cli/commands/eval.ts` now wraps the attempt itself in the **real `runVerifyLoop`** with
>    **acceptance == the task's own acceptance test** (`node test.cjs`), so "loop passed" ⇔ "task passes".
>    Gated by the real flags (`verifyLoop`/`verifyMaxRounds`): legacy = 1 shot, hardened = N + self-heal
>    (failing test output fed back each round).
> 2. **Hard corpus** `hardAgentEvalTasks` (`packages/benchmark/src/tasks.ts`): `hard-slugify`,
>    `hard-parse-duration`, `hard-roman-numeral` (multi-file — the fix lives in `numerals.cjs`, not the file
>    you're pointed at). Each `test.cjs` prints its failing cases to stderr so self-correction has signal.
> 3. **Auto-approver** for headless eval: `toolApprovalEngine.setMode("CI")` (auto-grants tool calls, still
>    refuses high-destructive) so hardened's `approvalInToolPath=enforce` doesn't fail tasks for a *security*
>    reason instead of a *coding* one. Stable — `recordConfidence`/`setMode` are never called in the live path.
> Also: real `rounds` (was hardcoded 0), `--suite easy|hard|all`, `--json` stdout is now pure JSON (stray
> module banners routed to stderr). Verified: benchmark+cli build clean, **13/13** benchmark tests, eval runs
> e2e (validation-only + a no-key `--agent` smoke; `rounds=1` recorded).
> **▶ TOP PICK FOR NEXT SESSION:** (a) **run the real comparison** (needs a BYOK key):
> `AGENCY_PROFILE=legacy agency eval --agent --suite hard --provider <p> --baseline .agency/eval-baseline-hard.json --update-baseline`
> then `AGENCY_PROFILE=hardened agency eval --agent --suite hard --provider <p> --baseline .agency/eval-baseline-hard.json`
> (gate hardened vs the legacy baseline) → commit the baseline + CI gate; (b) ~~wire the verify-loop into the
> main turn~~ **DONE for the one-shot CLI** — new `runChatTurnWithVerify` (`core/src/chat/verify-turn.ts`)
> wraps `agency chat`: after a turn that *edits files*, it runs the project's real acceptance scripts
> (`buildAcceptanceCommandsStrict` — build/lint/test, `[]` if none so a plain Q&A turn or script-less repo is a
> no-op) and self-heals on failure. Flag `AGENCY_VERIFY_MAIN_TURN` (defaults to `verifyLoop`: off legacy / on
> hardened; independently switchable). **The 4 interactive TUI call sites are deliberately NOT wired** (re-running
> a turn 3× mid-conversation under the user is a separate UX call). Edit-detection via `utils/workspace-snapshot.ts`.
> Tests: `core/__tests__/main-turn-verify.test.ts` (12). Green: core **341**, cli **547**, builds clean;
> (c) scope tests to changed files ("relevant tests" vs full suite); (d) context compaction (Phần 2.3).
>
> **UPDATE (2026-05-31b) — eval harness made actually-runnable (two defects the previous "green" claim hid).**
> A fresh `pnpm -r build` revealed the eval/verify-loop slice was **not** clean as logged.
> 1. **Build was broken.** `cli/src/commands/eval.ts` `makeAgentExecute(task, opts)` declared a `task:
>    BenchmarkTask` param it never used (the test file is the hardcoded `"test.cjs"` corpus convention;
>    `BenchmarkTask` doesn't even expose it) → `TS6133` under `noUnusedParameters` → `@agency/cli` failed to
>    compile. Fixed by dropping the dead param + its single call site.
> 2. **The deterministic smoke gate could never pass.** `scriptCompilationTask.validate`
>    (`benchmark/src/tasks.ts`) ran `npx tsc` inside the isolated workspace — but `createIsolatedWorkspace`
>    copies the repo **minus `node_modules`** (gitignored), so `npx tsc` found no local TypeScript and fell
>    through to the deprecated **`tsc` squatter** package ("This is not the tsc command you are looking for",
>    exit 1). The task failed in every clean environment → `agency eval` scored 2/3 and the gate vs the 3/3
>    baseline **always failed** (the old baseline was presumably recorded on a box with a cached/global tsc).
>    Fixed with `resolveTscBin()` → `createRequire(import.meta.url).resolve("typescript/bin/tsc")` and
>    `spawn(process.execPath, [tscBin], { stdio: "ignore" })` — hermetic, no network, no reliance on the temp
>    copy. Now `agency eval --json` = **3/3, gate PASS**. Regression guard added:
>    `eval-harness.test.ts` "script-compilation validates hermetically". Green: benchmark **14**, core **342**,
>    cli **547**, full `pnpm -r build` clean (16/16).
>    **Note:** `.agency/eval-baseline.json` is **gitignored** (local artifact) — "commit baseline + CI gate"
>    will need the baseline written somewhere non-ignored, or regenerated in CI. The BYOK-keyed
>    legacy↔hardened `--suite hard` comparison remains the user's step.
>
> **UPDATE (2026-05-31c) — real legacy↔hardened comparison RUN (BYOK key) + chat-path dedup.**
> The comparison the prior updates deferred to "the user's step" has now been executed against a
> real provider (NVIDIA NIM `minimaxai/minimax-m2.7`). Full methodology + numbers in
> [EVAL_RESULTS.md](EVAL_RESULTS.md). Summary: **hard suite (4 tasks) — legacy 4/4, hardened 4/4,
> gate PASS (Δ +0.0%, no regression).** Both one-shot every task (avg rounds = 1.0 in *both*
> profiles) → **ceiling effect**: this model is strong enough that the verify-loop never has a
> failing round to repair, so the corpus can't yet measure self-correction end-to-end (it is still
> proven by the mocked integration tests). Added a sharper discriminator `hard-csv-parse` (quoted
> commas / `""` escape / trailing empty field) — minimax one-shots it too. To actually measure the
> loop: grow the corpus beyond what the model one-shots, or run vs a weaker model. The hardened run
> also survived heavy NVIDIA rate-limiting (adaptive backoff/retry kept it 4/4).
> **Dedup (goal: avoid logic duplication):** `chat/orchestrator.ts` (`runChatTurn`) and
> `chat/stream.ts` (`runChatTurnWithStream`) — the two hottest turn paths — duplicated
> `resolveRoute` (byte-identical), `hasApiKey`/`providerHasKey` (identical logic, two names), and
> `repackContextAndSystemPrompt` (identical modulo input type). Extracted into a shared
> `chat/turn-helpers.ts` (typed on the base `ChatTurnInput`, since `ChatStreamInput extends` it);
> both files import from it, removing the silent-divergence risk. The larger ~50-line setup block
> was *deliberately left* — extracting it would pull `formatRouteSummary`/`buildSuggestedCommands`
> from orchestrator into the shared module and create a runtime import cycle; the divergence-prone
> logic (route cache, key resolution) is already gone. Verified: full `pnpm -r build` clean (16/16),
> **core 342, cli 547, benchmark 14**, all other suites green. Note: a stale `dist/chat/run-turn.*`
> (deleted source) lingers in the gitignored `dist/` — harmless, cleared on a clean rebuild.
>
> **More dedup (same session, codebase-wide scan):**
> - **cli:** `writeProcessOutput` was copy-pasted in `commands/{git,memory,compact}.ts` (git+memory
>   byte-identical; compact a 1-arg subset) and `exitFromResult` in `{compact,memory}.ts`. Both moved
>   to the shared `cli/src/utils.ts` (`writeProcessOutput(stdout, stderr?)` covers all three).
> - **tui:** `severityColor`+`severityIcon` for `RuntimeThoughtSeverity` were duplicated in
>   `CognitionPanel` and `ExecutionPanel` → shared `tui/src/utils/severity.ts`
>   (`thoughtSeverityColor`/`thoughtSeverityIcon`). This also **fixed a latent Windows bug**:
>   CognitionPanel hardcoded `⚠` for `warning`, but `SEVERITY_GLYPHS` deliberately uses the
>   single-cell `▲` (the comment notes `⚠` renders double-width on many Windows terminals). LogCollapse's
>   `severityIcon`/`severityColor` were left alone — `LogSeverity` ("error"/"debug") is a different domain.
> - Verified: cli **547**, tui **115**, full `pnpm -r build` clean (16/16).
>
> **UPDATE (2026-05-31d) — DEEP SCAN: two "built-but-unwired" defects found & fixed (the initiative's signature defect, again).**
> A codebase-wide scan for the audit's central pattern ("machinery exists but isn't wired into the live
> path") turned up two real instances that prior updates had marked DONE:
> 1. **`runChatTurnWithVerify` was never wired — and not even exported.** UPDATE-b/§5(b) claimed the
>    one-shot `agency chat` "now goes through `runChatTurnWithVerify`". It does not: `chat.ts` called
>    `runChatTurnWithStream`/`runChatTurn` directly, and `runChatTurnWithVerify` (built + covered by
>    `main-turn-verify.test.ts`) was absent from `core/src/index.ts` exports and had **zero call sites**.
>    Classic built-but-unwired. **Fixed:** exported it from core; wired it into the **streaming** chat path
>    (`chat.ts` — `runChatTurnWithStream` → `runChatTurnWithVerify`; byte-identical when flags off, since
>    the wrapper degrades to `runChatTurnWithStream`). **Then completed the default path too:** since
>    `--stream` is *not* the default, `verify-turn.ts` was refactored to an **engine-agnostic core**
>    (`verifyAndHeal(input, runTurn)`) with two thin wrappers — `runChatTurnWithVerify` (streaming) and
>    `runChatTurnWithVerifyResult` (non-stream, wraps `runChatTurn`); `chat.ts` now routes the default human
>    one-shot through the latter. `--json` deliberately stays on plain `runChatTurn` (machine consumers don't
>    want self-heal re-runs). No logic duplication (one loop, two engines); byte-identical when flags off
>    (cli 547 green); hardened non-stream path smoke-tested (no-LLM → routeOnly short-circuits, exit 0).
> 2. **Knowledge-graph dashboard advertised redaction it didn't do.** `core/graph/builder.ts` embeds
>    `JSON.stringify(payload)` into the file-written `.agency/knowledge/index.html` with a payload field
>    `redaction: "secret-like values ... are redacted"` — but there was **no redaction code** (repo-derived
>    commits/configs/vocabulary embedded verbatim → a secret-leak path + a false claim). **Fixed:** now runs
>    the canonical `IngestionPipeline.redactSecrets` (same detector as the secret-on-persist memory gate —
>    core already deps `@agency/memory`) over the serialized payload before embedding; label corrected (the
>    old "long hashes" claim was false — commit SHAs are intentionally shown).
> Also noted (NOT changed — low value / high friction): the `Math.ceil(text.length / 4)` token estimate is
> duplicated ~10× across providers/core/memory with divergent formulas (`round` vs `ceil`, a `+200` offset),
> so a shared `approxTokens` would shift behaviour on provider hot paths. Verified: full `pnpm -r build`
> clean (16/16), **core 342, cli 547**, all suites green.

### (A) Agent registry + capability-driven routing + health/utilization  ← DONE (2026-05-30)
**Landed & verified (full `pnpm -r build` clean; core 300 / cli 547):** new
`packages/core/src/agents/agent-registry.ts` — `CapabilityAgentRegistry` singleton `capabilityRegistry`:
capability seeds for the 8 MANIFEST_AGENTS, `rankForTask` (score = capability overlap + success-rate −
load penalty; filters below required clearance), `resolveAgentForTask` (reroutes ONLY on strictly-better
capability overlap; never touches unmodeled/custom agents or no-signal tasks), `recordOutcome` /
`markInFlight` / `markDone`, `inferCapabilities`, `snapshot`. Flag `capabilityRouting` in `flags.ts`
(env `AGENCY_CAPABILITY_ROUTING`, off legacy / on hardened). Wired into `dispatchAgent` (orchestrator.ts):
resolve→reroute (emits `subagent:routed`) BEFORE `enforceDelegationLimits` so the whole dispatch uses one
id; `markInFlight` after the dispatch commits; `recordOutcome`+`markDone` once exitCode is known. Both
`dispatch_subagent` and `dispatchAgentsParallel` funnel through `dispatchAgent`, so both paths are covered.
Exported from core `index.ts`; `agency status` shows the `Capability routing` flag + an `Agents` health/load
section (`getAgentRegistrySnapshot`). Test: `core/src/__tests__/agent-registry.test.ts` (12).
**Next pick from §5 is now (B) populate event attribution at publish sites.**

#### Original spec —
**Why:** the largest still-`partial` part of the Swarm subsystem; today routing is hardcoded by role and
agents expose no health/current-task/utilization (audit Swarm: "no capability-driven routing", "no health").
**Approach:** extend `agents/specialist-registry.ts` with runtime `health{success,failure,lastSeen}` +
`utilization{currentTask,inFlight}`; add `rankForTask({capabilities,clearance})`; have `dispatch_subagent`
(in `skill/tool-harness.ts`) and `dispatchAgent` consult the registry instead of `coerceAgentId` hardcoding.
Record outcomes in `dispatchAgent`'s finish/error paths. Surface in `agency status`. Flag
`AGENCY_CAPABILITY_ROUTING` (off legacy / on hardened); fall back to current role routing when off.
Contract sketch is in PRODUCTION_AUDIT.md §5(C).

### (B) Populate event attribution at publish sites  ← SUBSTANTIALLY DONE (2026-05-30)
`dispatchAgent` lifecycle publishes now pass `meta` → recorded in the `EventJournal` attribution
columns: `subagent:started`/`routed` → `agentId`; `subagent:finished`/`error` → `agentId` +
`durationMs` + **`costUsd`** (estimated from the turn's `completionMetadata.{promptTokens,
completionTokens}` via the now-public, pure `CostGovernor.estimateCost()` — never charges the
budget). **Remaining (minor):** a stable `taskId` once one is threaded through dispatch; the main
(non-subagent) turn already records cost via `globalCostGovernor.recordTokens` and surfaces it in
`agency status`. No new flag needed.

### (C) Atomic multi-file rollback  ← DONE (2026-05-30)
New `packages/workspace/src/mutation-journal.ts`: `commitMutationsAtomic(projectRoot, txId, mutations)`
persists the full before/after of every file to **`.agency/mutations/<txId>.json`** (a separate dir from
`.agency/tasks` so the checkpoint scanner can't mis-parse it) with status `committing` BEFORE any write,
applies each change, and rolls back inline on a write error; clears the journal on success.
`StagingEngine.commitTransactionAtomic()` drives it from the staged transaction. `recoverPendingMutations()`
(called from `bootstrapRuntime`, gated on `atomicRollback`, emits `recovery:mutation-rolled-back`) undoes
any `committing` journal a crashed run left behind → a half-applied commit is always rolled back on next
startup. `dispatchAgent` uses the atomic commit when `AGENCY_ATOMIC_ROLLBACK` is on, else the legacy
best-effort commit. Chat surfaces the rollback count. Test: `workspace/__tests__/mutation-journal.test.ts` (5).

### (D) Static DAG cycle detection + checkpoint schema versioning  ← DONE (2026-05-30)
- **Cycle detection:** `detectDagCycle(nodes)` in `task/runner.ts` (exported) — iterative DFS with a
  recursion stack, returns the offending cycle as an ordered node-id path or `null`; dangling deps ignored.
  `runPlan` runs it on the compacted DAG **before scheduling** and throws a typed `PlanCycleError`
  (+ emits `task:plan-cycle`) instead of letting the scheduler deadlock silently. **Always on** — a cycle
  is never a valid plan, so this only converts a hang into a diagnosable error.
- **Checkpoint integrity:** `TaskCheckpoint` gained a `checksum` field; `saveCheckpoint` seals a SHA-256 over
  the record (stale checksum stripped first; compact stringify, so on-disk pretty-printing is irrelevant);
  `loadCheckpoint` recomputes + compares. Legacy checkpoints (no checksum) skip the check and still load.
  On mismatch it always emits a `system:warning`; with `checkpointStrict` (flag `AGENCY_CHECKPOINT_STRICT`,
  warn legacy / reject hardened) it returns `null` rather than resuming a corrupt half-state.
- Test: `core/__tests__/dag-checkpoint-integrity.test.ts` (7). Exported `detectDagCycle`/`PlanCycleError` from core.

### (E) Secret-on-persist  ← DONE (2026-05-30)
`SqliteStorageBackend.addEpisode()` now **redacts** detected secrets in `content`
(`IngestionPipeline.redactSecrets()` — added; reuses the existing `SECRET_PATTERNS`, global-replaces with
`[REDACTED-SECRET]`) so the episode + its FTS index never store the raw value. `insertVector()`
**quarantines** a secret-bearing vector to the existing `quarantined_vectors` table instead of the live,
searchable `vectors` store. Both are gated by a module toggle `setSecretScanEnabled()` (`memory/src/secret-policy.ts`)
that `bootstrapRuntime` flips from `flags.secretScan` (memory can't import core flags — would cycle). Off in
legacy (verbatim), on in hardened. Backend exposes `getSecretScanStats()`. Flag `AGENCY_SECRET_SCAN`.
Test: `memory/__tests__/secret-on-persist.test.ts` (4).

### (F) True auto-resume (completes `AGENCY_AUTO_RECOVER`)  ← DONE (2026-05-30)
`autoResumeRecoverableTasks(projectRoot, opts?, bus?)` in `runtime/bootstrap.ts` (exported from core):
flag-gated (`autoRecover`, no-op + `[]` when off → legacy unchanged). Resumes only `running`
checkpoints (a run that *died* mid-execution) via `runPlan(projectRoot, planPath, {taskId})`; `paused`
tasks are intentional and left for explicit `agency task resume`. **Crash-loop guard:** a per-task
attempt counter at `.agency/resume/<id>.json` (separate dir so `listCheckpoints` — which scans
`.agency/tasks/*.json` — can't mis-parse it) is incremented **before** runPlan, so a crash *during*
resume is still counted; after `maxCrashLoops` (`AGENCY_MAX_CRASH_LOOPS`, default 3) it's abandoned
(emits `task:resume-abandoned`, escalates to human) instead of looping; a `done` run clears the counter.
Emits `task:resume-start|finished|error|abandoned` (with `taskId`/`durationMs` attribution). Wired into
`cli/commands/chat.ts`: when `autoRecover` on, auto-resumes + reports each outcome and surfaces remaining
paused tasks; legacy still just prints the "interrupted task(s)" hint. Test: `core/__tests__/auto-resume.test.ts` (4).
**This completes maturity tier 2 ("recoverable").**

Remaining beyond these: cross-dispatch loop detection at orchestrator scope; periodic health monitor for
tools/MCP/plugins; full artifact system (id/owner/version). See PRODUCTION_AUDIT.md §2 gap matrix.

---

## 6. Git / commit state  ✅ (2026-05-31 — repo now has history)

- Branch: **`master`** (main branch for PRs is `main`). The repo previously had **ZERO commits**; the entire
  initiative now sits on a real commit history. **Tree is clean.** Commits:
  | Commit | What |
  |---|---|
  | `0d216b9` | **Initial commit** — recovery point capturing the whole hardened tree (981 files). `*.tsbuildinfo` gitignored at commit #1. |
  | `656498d` | `fix(memory)`: `safeAddEpisode` silently swallowed every episode-write failure; now emits a best-effort `system:warning` (keeps no-throw). |
  | `1cb58c1` | `ci`: `pnpm verify` (= build all + test all) + `.github/workflows/ci.yml` (windows-latest, push main/master + PR). |
  | `b9f33e9` | `feat(context)`: wire **§2.3 conversation compaction** into both turn paths (was built-not-wired; one shared `compactTurnHistory`). |
- **Each commit was verified before claiming green** (`pnpm verify` / per-package `vitest run`) — the cure
  for this repo's recurring "claimed green but build was actually broken" handoffs. **Always run `pnpm verify`
  before asserting green.**
- CI activates once a GitHub **remote** exists (repo is currently local-only; `PUBLISH.md`/publish scripts
  imply a remote is intended). End commit messages with the Co-Authored-By trailer.
- Runtime-created `.agency/` dirs and `*.tsbuildinfo` build caches are gitignored.

## 7. How to resume in one minute
```bash
pnpm -r build                                   # must be clean (all 16 packages)
pnpm verify                                     # THE ground-truth gate: build all 16 + test all (~2002, exit 0)
# or per-package: core 348 / cli 550 / tui 115 / memory 34 / workspace 11 / benchmark 14 / providers 840 ...
agency eval --json                              # run the eval suite + (if present) the regression gate
agency status --json                            # see active flags (25)
AGENCY_PROFILE=hardened agency status            # see hardened posture (auto-recover, GC, budgets, compaction…)
```
**Starting a brand-new session?** Paste `docs/SESSION_HANDOFF_PROMPT.md` as the first message — it points the new session at this doc + the no-duplication map and enforces the investigate→verify→commit rhythm.
Then open this file (read §5 **LATEST** banner → git history + verify gate + §2.3 compaction wired + the wired-or-dead audit; **top pick is wire-or-delete one dead module, or grow the eval corpus & measure**) + ROADMAP_HANDOFF.md +
PRODUCTION_AUDIT.md §2 (gap matrix). Memory note for the assistant: see
`agencycli-production-hardening` in the project memory.

### TUI reliability fixes shipped this session (not in the audit, but load-bearing for "operate correctly")
1. **Subagent-stream freeze** (slice 6): per-token full-transcript `subagent:progress` publishes caused
   O(n²) + a synchronous large-payload `writeFileSync` *per token* → event-loop starvation. Throttled +
   constant-size payloads; `EventBus` large-payload spill is now async. (`agents/orchestrator.ts`, `events/event-bus.ts`.)
2. **Elapsed-counter lag**: elapsed readouts now self-tick in leaf components (`LiveElapsed` + `spawnTs`);
   removed the 1s whole-App heartbeat; `setSubagents` floored to 250ms. (`App.tsx`, `SubagentPanel.tsx`, `ToolActivity.tsx`.)
3. **"Eject to shell"** (slice 7): non-fatal global error handlers (`reportRuntimeError`) + `AppErrorBoundary`
   + `EventBus.publish` never rejects → a stray rejection / render throw can no longer drop the user to the
   shell. (`terminal/screen.ts`, `components/AppErrorBoundary.tsx`, `index.ts`, `events/event-bus.ts`.)
   **Known residual:** some lag is intrinsic (Windows ConPTY full-frame redraw + synchronous core ops in the
   dispatch path — `safeAddEpisode` SQLite writes, `buildIndex`/`writeIndex` re-index). Candidate: worker-thread offload.
