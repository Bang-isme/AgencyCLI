# Event-First Runtime — Architecture & Migration

> Target: make AgencyCLI feel like *a software operating environment for agents*,
> not a chat interface that occasionally runs tools. The runtime is the product;
> the LLM is one subsystem; the TUI renders **structured runtime events**, never
> parsed assistant text.

This document maps the requested architecture onto what AgencyCLI **already has**,
identifies the **real gaps**, and gives an **incremental, flag-gated** migration
(legacy byte-identical until each flag is on) consistent with this repo's
discipline (`docs/SESSION_HANDOFF_PROMPT.md`).

Legend: ✅ exists & wired · ◐ exists but partial / not event-driven · ✗ missing.

---

## 0. The one architectural defect (what the screenshots show)

The screenshots (CS2 Academy build) show three symptoms — tool lines dumped into
the message, reasoning prose between steps, and a verbose
`⚠ [SYSTEM: Reached the maximum 15 …] / send "continue"`. All three trace to a
**single root cause + two profile issues**:

- **Root cause (architectural):** the tool lifecycle is emitted as **text on the
  assistant stream**. `core/chat/stream.ts:463` does
  `handlers.onDelta(formatToolCallNotice(...))` → injects
  `⚡ [SYSTEM: Executing tool "write_file" on …]` into the *same* `onDelta`
  channel as prose; `:527` injects the completion line. The TUI then re-parses
  that text to reconstruct activity. **This is the "TUI parses assistant text"
  violation.** Everything else is downstream of it.
- **Profile issue:** the screenshots are the **legacy** profile with the **old
  dist** — `timelineParts`/`transcriptNav` off, the unified renderer not even
  running. (Rebuild + `AGENCY_TIMELINE_PARTS=1` already removes the verbatim
  `[SYSTEM:]` and unifies the render — but it *still parses text*; see §2/§9.)
- **Max-loop exposure:** auto-continue exists (`autoContinue` flag, default on)
  but only fires on *explicit* "unfinished" signals, not on **loop-exhaustion**.
  Loop-exhaustion still surfaces the `[SYSTEM: Reached maximum …]` notice +
  "send continue" (stream.ts:~628). Making that invisible is §7.

**The fix is not a rewrite.** The EventBus (✅), checkpoints (✅), recovery (◐),
safety (✅), memory (✅), orchestrator (✅) already exist. The work is: put the
**tool lifecycle on the bus the TUI already subscribes to**, render a dedicated
**Activity Timeline** from it, and **stop injecting `⚡ [SYSTEM:]` into `onDelta`**.

---

## 1. Runtime architecture (subsystem map — mostly present)

| Subsystem | Status | Where it lives today |
|---|---|---|
| Agent Runtime | ✅ | `core/chat/{stream,orchestrator,turn-helpers}.ts` (turn loop, tool loop, continuation) |
| Tool Runtime | ✅ | `@agency/tooling` ToolRegistry + `core` tool harness (21 tools) |
| Event Bus | ✅ | `core` `EventBus` (singleton, in-memory journal + durable SQLite journal via `persistEvents`) |
| State Manager | ◐ | `tui/sessions/store.ts` (session messages) + `core` checkpoints; **no first-class Goal/Plan/Step runtime state outside `/goal`** |
| Memory System | ✅ | `@agency/memory` (SQLite episodic + vectors) + `MarkdownMemoryStore` + `remember` tool |
| Checkpoint System | ✅ | `core` checkpoints (`listCheckpoints`, DAG checkpoint integrity, `checkpointStrict`) + `workspace-snapshot` (mtime/size) |
| Recovery Engine | ◐ | `autoRecover`, `discoverRecoverableTasks`, crash-loops, circuit breaker, `verifyLoop`/`verifyMainTurn`, `autoContinue`, `resumeContinuation` — present but **not composed into invisible loop-exhaustion continuation** |
| Safety Layer | ✅ | `core/terminal/sandbox.ts` (self-kill refusal), `@agency/security` egress proxy, RiskAssessor + approval engine, `pathConfinement` |
| Activity Timeline | ✗ | **does not exist as a panel** — activity is reconstructed from `⚡ [SYSTEM:]` text inside `Conversation.tsx` |
| Conversation Layer | ◐ | `Conversation.tsx` — but it carries tool/reasoning text mixed with prose |
| Task Orchestrator | ✅ | `core/agents/orchestrator.ts` + agent registry + parallel dispatch + delegation guards; `GoalRunner` for `/goal` |
| Built-in Toolchain | ✅ | filesystem/terminal/search/memory/checkpoint/diff/patch/ast/git-ish/grep/find — all registered |

**Principle to enforce going forward:** each subsystem is a runtime service that
**emits events**; the TUI is a pure subscriber. Today only subagents/plan/system
events reach the TUI; the tool lifecycle does not.

---

## 2. Event model

### Today (◐)
- `EventBus` carries: `subagent:started|progress|finished|error`, `plan:updated`,
  `system:warning`, `security:egress-denied`, `chat:verify-failed`,
  `chat:self-healing`. These **already drive TUI panels** (App.tsx:767–771,
  999–1001, 1681) — proof the event→TUI pattern works.
- The **tool lifecycle is NOT on the bus** — it is `onDelta` text.

### Target canonical taxonomy (the spec, namespaced to fit the existing bus)
```
task:created | task:started | task:completed | task:failed
plan:created | plan:updated | plan:step-started | plan:step-done
tool:started | tool:finished | tool:failed
fs:read | fs:write | fs:edit | fs:delete
exec:start | exec:end
build:started | build:failed | build:success
checkpoint:created | checkpoint:restored
memory:updated
safety:blocked
continuation:started | continuation:completed
```
Every event: `{ ts, turnId, seq, kind, payload, status }`. `seq` is a per-turn
monotonic counter so the timeline orders deterministically (today ordering is lost
in the dual-buffer merge — see the recon in `agencycli-tui-opencode-parity.md`).

### The dual-channel rule (the core contract)
- **`onDelta` carries ONLY assistant prose** (the Conversation/summary layer).
- **Tool lifecycle goes on the EventBus** (the Activity Timeline layer).
- `formatToolCallNotice`/`formatToolCompletion` text injection is removed (behind
  a flag) once the timeline subscribes to the events.

### Gap → increment
Add `tool:*`, `fs:*`, `exec:*`, `build:*` publishes at the execution boundary
(`stream.ts` around 463/527, and in the tool harness where exec/build run). This
is **additive** (new event kinds; nobody breaks) → no flag for the *emit*; the
flag gates *suppressing the text* (§9).

---

## 3. State model

### Today (◐)
- Session = `AgencySession { id, messages[] }` (tui/sessions/store.ts) — the
  conversation, persisted + forkable (✅ P4b `forkSession`).
- Checkpoints persist task/plan/step state for `/goal` runs (`listCheckpoints`).
- **Gap:** a plain chat turn has no first-class `RuntimeState { goal, plan,
  currentStep, completed[], pending[], failed[], modifiedFiles[], context }`
  outside the GoalRunner.

### Target
A `RuntimeState` service in `core` (single source of truth), updated by events
(reducer over the event stream), persisted into checkpoints, surfaced to the TUI
Task/Status panels. `modifiedFiles` already exists implicitly (the max-loop notice
lists them) — promote it to state.

### Increment
Derive `RuntimeState` as a **reducer over the EventBus journal** (we already
persist the journal). No new write path — fold existing events; add the missing
`tool:*`/`fs:*` ones from §2. Resumability falls out of checkpoint + journal.

---

## 4. Tool runtime

### Today (✅, needs event emission + uniform envelope)
ToolRegistry tools already have: confinement (`pathConfinement`), risk/approval,
tail-kept results, reassembly, mkdir-parents, `$`-safe replace, edit-mismatch
diagnostics (all the churn fixes in memory). Missing vs spec: **uniform
per-tool event emission + structured-output envelope + per-tool timeout/retry
surfaced as events**.

### Target
Wrap every tool invocation in one harness that emits `tool:started` →
(`fs:*`/`exec:*`/`build:*` as appropriate) → `tool:finished|failed`, with
`{ name, args(redacted), durationMs, exitCode, bytes, summary }`. Timeouts/retries
emit events too. The **audit trail = the journal** (already durable).

### Increment
One `withToolEvents(tool, args, run)` wrapper at the single call site in the tool
loop. Replaces the `onDelta(formatToolCallNotice(...))` line.

---

## 5. Memory architecture

### Today (✅ — strong)
- Episodic SQLite + vectors (`memorySemantic`), GC/quota, secret-scan on persist.
- Curated **markdown** memory (`MarkdownMemoryStore` + `remember` tool,
  `fileMemory` default-on) — the Claude-Code-style layered memory.
- Subagents inherit memory (guard `0721095`).

### Target layering (mostly a taxonomy over what exists)
Architecture / ADR / Operational / Knowledge / **Handoff** memory = *categories*
of markdown memory (the store already has `metadata.type`: user|feedback|project|
reference). Add `adr` + `handoff` types. **Auto-handoff**: on
`continuation:started` / session end, generate a handoff memory (goal, plan,
completed/pending, modified files) from `RuntimeState` (§3).

### Increment
Add `adr`/`handoff` to the markdown memory type union; a `writeHandoff(state)`
that the continuation/teardown path calls. Reuses `MarkdownMemoryStore`.

---

## 6. Checkpoint architecture

### Today (✅)
DAG checkpoints with integrity + strict mode; `workspace-snapshot` (mtime/size).
Triggers exist for `/goal` phases.

### Target
Generalize checkpoint triggers to **any** turn: every N tool calls, N file mods,
phase/build completion, context threshold. Store `{ goal, plan, completed,
pending, modifiedFiles, runtimeMeta }` = exactly `RuntimeState` (§3). For
**content** revert (P5 in the TUI plan) we need the chosen content-snapshot infra
(`.agency/checkpoints/<session>/<msgId>/`) — `workspace-snapshot` is mtime/size
only and can't restore.

### Increment
Event-triggered checkpoint writer subscribing to `tool:finished`/`build:success`/
context events; reuse the existing checkpoint store + add the content-snapshot dir.

---

## 7. Recovery architecture (this kills "send continue")

### Today (◐ — pieces exist, not composed)
- `autoContinue` (explicit-unfinished only), `resumeContinuation` (folds a resume
  notice), circuit breaker (`scopedCircuitBreaker`, `breakerFailedExits`),
  `verifyLoop`/`verifyMainTurn` (build/test self-heal), `autoRecover` (crash
  resume). The **diagnose→repair→retry→verify** loop exists for *edits*
  (verifyMainTurn) and *crashes* (autoRecover) but **not for loop-exhaustion**.

### Target — invisible continuation
On loop-exhaustion: `checkpoint` → `compress context` (we have
`contextCompaction`) → emit `continuation:started` → resume the turn
automatically (bounded), → `continuation:completed`. The user sees a quiet
timeline row (`↻ continuing…`), **never** "send continue". Guardrails (critical —
this is why it was deferred): a **cross-turn budget** + **no-progress detector**
(if N continuations make zero `fs:write`/`build` progress, stop and surface one
calm line) so it can't recreate the 6-minute runaway. `AGENCY_MAX_LOOPS` is the
current manual lever.

### Increment (phased, behind a flag)
`autoContinueOnExhaustion` flag: when a turn hits `maxLoops` with modified files
and a progress delta since the last continuation, auto-resume up to a bounded
budget; on no-progress, fall back to today's notice. Compose the existing pieces;
add only the budget + progress detector. **Validate live** (runaway risk).

---

## 8. Safety layer (✅ — mostly done, tighten output)

Self-kill refusal (sandbox.ts), egress allow-list (security), RiskAssessor +
approval, path confinement all exist. Spec deltas: (1) emit `safety:blocked`
events for the timeline instead of prose; (2) user-facing text already terse for
self-kill (`9f58e9d`) — extend the "one line, details in timeline" rule to all
blocks. Pre-execution interception already happens; just re-route the *reporting*
to events.

---

## 9. TUI architecture (the visible payoff)

### Target layout (operator clarity in 3 seconds)
```
┌ Conversation ───────────────┐  prose-only summaries (onDelta)
│ "Build failed: Tailwind cfg" │
│ "Fixed and rebuilt."         │
├ Activity Timeline ──────────┤  EventBus-driven, virtualized, collapsible, filterable
│ ✓ write Hero.tsx            │
│ ✓ exec npm run build        │
│ ✗ build failed              │
│ ✓ edit globals.css          │
│ ✓ build success             │
├ Tasks ──────────────────────┤  RuntimeState plan/steps
├ Status ─────────────────────┤  model · tokens · breaker · checkpoint
└─────────────────────────────┘
```
### Today (◐) → Target
- `timelineParts` already unified the render & made activity concise, **but it
  still parses `m.content` text**. Target: a `<ActivityTimeline>` that subscribes
  to `tool:*`/`fs:*`/`exec:*`/`build:*` (like `SubagentPanel` subscribes to
  `subagent:*` today) and renders flat lines (HARD CONSTRAINT: flat line-pool, no
  bordered cards — see recon). Conversation then renders **only prose**.
- The P2/P4 transcript focus/copy/fork layer (`9755a1a`…`cbfc59e`) already gives
  operator navigation; it will target timeline rows + turns.

### Increment
1. `<ActivityTimeline>` panel fed by an event store hook
   (`useRuntimeEvents()` subscribing to the bus) — mirrors the proven
   `globalWorkerTracker`/`subagent:*` pattern.
2. Flag `eventDrivenActivity`: when on, the timeline renders from events **and**
   the `⚡ [SYSTEM:]` `onDelta` injection is suppressed (Conversation = prose).
   Off = today's behavior byte-identical.

---

## 10. Migration plan (incremental, flag-gated, maps to the screenshots)

Each phase: a flag in `core/runtime/flags.ts`, legacy byte-identical, small
commits, `pnpm verify` REAL_EXIT_CODE=0. Ordered by impact-on-the-screenshots ÷ risk.

- **Phase A — Emit the tool lifecycle (additive, no flag, zero UI change). ✅ DONE.**
  `core/chat/tool-events.ts` (pure `classifyTool`/`toolTarget`/`toolResultIsFailure`
  + `emitToolStarted`/`emitToolFinished`) publishes `tool:started` and
  `tool:finished`/`tool:failed` on the EventBus at the tool boundary
  (stream.ts ~463/527), with a per-turn `seq` so the timeline orders
  deterministically and the bus dedup-cache can't merge distinct calls. Emitted
  ALONGSIDE the legacy `⚡ [SYSTEM:]` text → nothing consumes the events yet → no
  behaviour change. Tests: tool-events (4, pure) + a chat-stream wiring test that
  subscribes to the bus and asserts the events fire. (`fs:*`/`exec:*`/`build:*`
  specialisation deferred to their consumers — Phase E recovery; today the
  `category`/`action` fields carry that info.)
- **Phase B — Activity Timeline panel (flag `eventDrivenActivity`).** Add
  `<ActivityTimeline>` + `useRuntimeEvents()`; render from Phase-A events.
  Still also show the text (both) so it's verifiable side-by-side.
- **Phase C — Cut the text round-trip (same flag).** When `eventDrivenActivity`
  on, suppress `formatToolCallNotice`/completion `onDelta` injection →
  Conversation becomes prose-only. This is the "no tool spam in chat" win.
- **Phase D — RuntimeState reducer + Task/Status panels. ◐ PARTIAL.** The reducer
  landed: `core/runtime/runtime-state.ts` `reduceRuntimeState(events)` (PURE fold)
  + `loadRuntimeState(projectRoot)`, consumed by `agency status` (flag
  `runtimeState`, default hardened-on). Folds plan/steps, modified files, tool +
  agent health, continuations, warnings, cost from events the bus already emits —
  no new write path. **Pending:** the TUI Tasks/Status panel consumer (folds the
  same reducer live off the bus — do NOT add a second derivation).
- **Phase E — Invisible continuation (flag `autoContinueOnExhaustion`, default-on). ✅ DONE `411b2e2`.**
  A productive iteration that would exhaust `maxLoops` extends the budget one
  window instead of stopping with "send continue". Three guards prevent the old
  6-min runaway: progress-gated (only while files-written keeps GROWING), hard
  ceiling (`maxLoops × 4`), + the circuit breaker. Emits `continuation:started`.
  **Still live-validate on a real big build.** (`timelineParts` also promoted
  default-on `bc7503e`.) Phase H (reasoning-spam) deferred — system-prompt change,
  validate on a real model run.
- **Phase F — Checkpoint generalization + content-snapshot revert (TUI P5).**
- **Phase G — Auto-handoff memory + ADR types (§5).**
- **Phase H — Safety/blocked → events (§8), reasoning-spam suppression** (prompt:
  the model narrates less between steps; the timeline carries the "what", the
  conversation carries the "why" as a summary).

**Promotion:** no flag flips to default without the user visually validating
(the user's eyes are the validation loop for the central render). `timelineParts`
+ `transcriptNav` are the current pending-validation flags.

### What NOT to rebuild (anti-duplication)
EventBus, checkpoint store, circuit breaker, approval/RiskAssessor, egress proxy,
memory stores, agent registry/orchestrator, GoalRunner — all exist. Extend them;
do not introduce parallel systems (the repo's documented "built-but-unwired" +
"duplication" diseases).
