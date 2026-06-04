# AgencyCLI — Completion & Consistency Contract

> **Why this doc exists.** "Hoàn thiện hoàn hảo, không sót gì" cannot be a *claim*
> — it must be *verifiable*. This is the single page that makes "complete" and
> "the docs match each other and the code" **enforceable and re-checkable**, not
> asserted. It reconciles the design (`AGENT_OS_BLUEPRINT.md`), the migration
> (`EVENT_FIRST_RUNTIME.md`), the campaign log (`ROADMAP_HANDOFF.md §8`), the
> module reference (`PACKAGES.md`), and the frontier (`NEXT_SESSION_PROMPT.md`)
> into one coherent, verified whole.
>
> **The rule that makes it stay true:** structural facts are *guard-enforced* (a
> test fails `pnpm verify` on drift); volatile facts are *pointer-to-live* (never
> hardcoded except in one dated banner). Drift becomes a test failure, not a
> silent rot.

---

## 1. Verified ground truth (re-run to refresh; do not trust without re-running)

**Measured 2026-06-05 (post docs-consistency guard + K1 RuntimeState), `master`,
clean tree. `pnpm verify` (= `pnpm -r build && pnpm -r test`) → build 16/16,
REAL_EXIT_CODE=0.**

| Package | tests | Package | tests | Package | tests |
|---|---:|---|---:|---|---:|
| core | 504 | cli | 588 | tui | 208 |
| providers | 855 | memory | 48 | security | 39 |
| benchmark | 18 | tooling | 14 | workspace | 11 |
| telemetry | 9 | governance | 7 | context | 6 |
| heuristics | 6 | browser | 5 | skills-bridge | 18 (+1 skip) |

**Totals: ≈ 2336 passing · 16 packages · 21 built-in tools · 8 agents · 28 skills ·
8 workflows · 42 runtime flags (43 `getRuntimeFlags()` keys incl. `profile`).**

> These numbers are a **dated snapshot**. The live source is always `pnpm verify`
> (test totals, flag count) + `agency status` (flags) + the guard in §3 (structural
> counts). When you read this on a later date, re-run before relying on it.

---

## 2. Source-of-Truth Map (the anti-drift contract)

Every fact has exactly **one** authoritative home and **one** way to verify it. A
doc may *reference* a fact; it must not *re-assert* a volatile number (that is how
`ROADMAP §8` drifted to "33 cờ · 20 tool" while the truth was 41/21 — see §6).

| Fact | Authoritative source (code/data) | How to verify | Enforced? | Where it may be quoted |
|---|---|---|---|---|
| Built-in tool set (names + count) | `toolRegistry.listTools()` (`skill/tool-harness.ts`) | `docs-consistency` guard | ✅ guard | `PACKAGES.md` only |
| Manifest agents (ids + count) | `MANIFEST_AGENTS` (`agents/types.ts`) | `docs-consistency` + `agent-dispatch-integrity` | ✅ guard | `PACKAGES.md`, `SKILLS_PACK.md` |
| Workspace package count | `packages/*/package.json` dirs | `docs-consistency` guard | ✅ guard | any (stable = 16) |
| Skills / workflows (count + members) | `manifest.json` (`skills`, `workflows`) | `docs-consistency` + `skills-manifest-integrity` + `workflow-pack-integrity` | ✅ guard | `PACKAGES.md`, `SKILLS_PACK.md` |
| Runtime flags (the set) | `getRuntimeFlags()` keys (`runtime/flags.ts`) | `agency status` completeness test (`buildFlagRows`) | ✅ guard (set, not count) | none — quote via `agency status` |
| Flag **count** (volatile) | derived from the set | `agency status` / count keys | ⛔ pointer-to-live | ROADMAP §8 dated banner only |
| Per-package test totals (volatile) | `pnpm verify` output | `pnpm verify` | ⛔ pointer-to-live | ROADMAP §8 dated banner only |
| Canonical homes / no-dup map | `PACKAGES.md` "Canonical Homes" | dup-scan + cycle guards | ✅ guards | `PACKAGES.md` only |
| Import-cycle invariants | code | `architecture-cycles` + `package-cycles` | ✅ guard | — |
| Roadmap status (done/partial/open) | `git log` + this doc §5 + `ROADMAP §8` | read `git log`; re-verify claims | ⛔ human-maintained | §5, ROADMAP, NEXT_SESSION |

**The one structural rule:** if a number is *stable* (tool/agent/package/skill/
workflow), it lives in `PACKAGES.md` and is **guard-locked**. If a number is
*volatile* (tests, flag count), it is **never hardcoded** outside the one dated
`ROADMAP §8` banner — everywhere else says "run `pnpm verify` / `agency status`".

---

## 3. The integrity guards (8) — drift = a failed build

These are the machine that keeps the system honest. All run inside `pnpm verify`.

| Guard | File | Fails the build when… |
|---|---|---|
| Skills ↔ manifest | `cli/__tests__/skills-manifest-integrity.test.ts` | a SKILL.md is undeclared, or a manifest skill has no SKILL.md |
| Agents ↔ prompt/seed | `core/__tests__/agent-dispatch-integrity.test.ts` | `MANIFEST_AGENTS`, prompt templates, capability seeds drift apart |
| Module import cycles | `core/__tests__/architecture-cycles.test.ts` | a non-functional module enters a runtime cycle |
| Package import cycles | `cli/__tests__/package-cycles.test.ts` | any `@agency/* ↔ @agency/*` runtime cycle forms |
| Dependency hygiene | `cli/__tests__/package-cycles.test.ts` | a declared `@agency/*` dep is unused, or an imported one undeclared |
| Workflow ↔ pack scripts | `cli/__tests__/workflow-pack-integrity.test.ts` | a workflow step or builtin script path is missing on disk |
| Flags ↔ `agency status` | `cli` status completeness test | a `getRuntimeFlags()` key isn't surfaced by `buildFlagRows` |
| **Docs ↔ code (NEW 2026-06-05)** | **`cli/__tests__/docs-consistency.test.ts`** | **a tool/agent/package/skill/workflow is undocumented, or `PACKAGES.md` states a wrong structural count** |

> The 8th guard is what this session added so the §6 drift can never silently
> recur. It pins only *stable* facts (per §2); volatile counts stay pointer-to-live.

---

## 4. Definition of Done (the per-slice contract — "không sót" at the unit level)

A change is **DONE** only when every box is checked. This is the checklist that
guarantees nothing is half-wired or undocumented. (Same spine as
`SESSION_HANDOFF_PROMPT.md §5`, restated here as the acceptance gate.)

- [ ] **Wired, not dangling** — the new code has a live caller (no built-but-unwired). Verified by running the real command/tool, not by reading.
- [ ] **No duplication** — checked `PACKAGES.md` Canonical Homes first; reused the home, didn't fork it. Cycle + dup guards green.
- [ ] **Flagged if behavioural** — a flag in `runtime/flags.ts`, legacy byte-identical when off (additive tool/command/doc/UI-copy/bug-fix needs no flag).
- [ ] **Tested** — a test covers the new behaviour AND the legacy (flag-off) path.
- [ ] **`pnpm verify` REAL_EXIT_CODE=0** on 16/16 packages — not asserted, run.
- [ ] **All 8 guards green** (§3).
- [ ] **Docs synced in the same change** — `PACKAGES.md` if structural; the relevant living doc (ROADMAP §8 / EVENT_FIRST / NEXT_SESSION) for status; never copy a volatile number.
- [ ] **Memory synced** — `memory/` topic file + `MEMORY.md` pointer if it's a "don't re-investigate" fact.
- [ ] **User-validated** — for any TUI-render flag, the user has visually confirmed it (the user is the only validator of the central render).
- [ ] **Not auto-promoted** — hardened→default and BYOK only on explicit user OK.

---

## 5. Completeness Ledger (the whole roadmap, reconciled — "không sót" at the program level)

Status against the two design docs + the frontier. Evidence is a commit, a flag,
or a guard — never a vibe. ✅ done & wired · ◐ partial · ✗ not started.

### 5A. Event-first migration (`EVENT_FIRST_RUNTIME.md` A→H)
| Phase | What | Status | Evidence |
|---|---|:--:|---|
| A | Tool lifecycle on the bus (`tool:*`) | ✅ | `05a1f50`, `chat/tool-events.ts` |
| — | `timelineParts` promoted default-on | ✅ | `bc7503e`, flag default `true` |
| E | Invisible continuation on loop-exhaustion | ✅ | `411b2e2`, flag `autoContinueOnExhaustion` |
| B | `<ActivityTimeline>` panel from events | ✗ | flag `eventDrivenActivity` (== K4) |
| C | Cut the `⚡[SYSTEM:]` text round-trip | ✗ | same flag (== K4) |
| D | `RuntimeState` reducer over the journal | ◐ | reducer + `agency status` consumer landed (flag `runtimeState`); TUI panels pending. **== K1** |
| F | Checkpoint generalization + content-snapshot revert | ✗ | TUI P5 |
| G | Auto-handoff memory + adr/handoff types | ✗ | reuse `MarkdownMemoryStore` |
| H | `safety:blocked` events + reasoning-spam suppression | ✗ | prompt + safety |
| — | `transcriptNav` | ◐ | flag exists, opt-in, not promoted |

### 5B. Agent-OS keystones (`AGENT_OS_BLUEPRINT.md`)
| Keystone | Status | Note |
|---|:--:|---|
| K1 `RuntimeState` (reducer over durable journal) | ◐ | `reduceRuntimeState` + `agency status` consumer **DONE** (flag `runtimeState`, `core/runtime/runtime-state.ts`); TUI Tasks/Status panel consumer pending (== EVENT_FIRST D) |
| K2 Session Hierarchy (subagent → real session) | ✗ | `dispatch-*.json` is the proto-record to formalize |
| K3 Supervisor Runtime (one observer over 6+ detectors) | ✗ | biggest compose-don't-build win |
| K4 Activity Timeline (event-fed surface) | ✗ | == EVENT_FIRST B/C; the visible payoff |
| Phase 3 Unified Kernel (`core/kernel/`) | ✗ | K1-blocked (needs shared state to unify the envelope) |
| Replay forensic surface | ◐ | both engines exist (`replay-engine.ts` + `telemetry/replay.ts`); the *surface* is ✗ |

### 5C. Frontier / hardening (`NEXT_SESSION_PROMPT.md`, `agencycli-production-hardening`)
| Item | Status | Note |
|---|:--:|---|
| P0 churn-cluster promote (4 flags default-on) | ✅ | `6c0a9f6` |
| (e) skills/plugin pipeline e2e tight-coupling | ◐ | mostly done (cont'd 27); 2 minor translator dups deferred |
| (c) structured tool-card vs text-in-stream | ✗ | == K4 |
| (a) amateur-tell / de-fake sweep | ◐ | user-facing near-complete; marginal internal remnants |
| Production-audit findings (`PRODUCTION_AUDIT_APPENDIX`) | ◐ | many resolved post-audit (e.g. `maxParallelAgents` is now a flag) but the appendix is a **point-in-time artifact** and does not mark them resolved — read it as historical, cross-check against code/`git log` |
| BYOK eval + remaining hardened→default promotions | ✗ | **LAST step**, needs a real key + explicit user OK |

**Reading of "complete":** the *runtime substrate* is effectively complete (L3 on
events/tools/memory/orchestration/safety/recovery). What remains is the **operator
surface** (K1–K4) + the **forensic/kernel polish** + the **BYOK-gated promotions**.
That is the honest definition of "what's left" — there is no hidden backlog beyond
this ledger; if work appears that isn't here, this ledger was incomplete and must
be updated in the same change.

---

## 6. Drift found & fixed (2026-06-05)

The consistency sweep that produced this doc. Each was a real doc↔code or
doc↔doc contradiction.

| Drift | Was | Now | Fix |
|---|---|---|---|
| `ROADMAP §8` baseline banner (the designated baseline home) | `core 424 · tui 148 · providers 852 · ~2175 test · 33 cờ · 20 tool` | verified `core 496 · tui 208 · providers 855 · ~2321 test · 41 cờ · 21 tool`, dated, pointer-to-live | edited + dated banner |
| `ROADMAP §8` internal contradiction | "33 cờ" (l.451) vs "36 cờ" (l.457/459) | banner clarifies older lines are point-in-time snapshots | note added |
| `EVENT_FIRST` tool count | "(20–21 tools)" | "(21 tools)" | edited |
| **No enforcement** of doc↔code counts | counts could rot silently | `docs-consistency.test.ts` guard (§3) | new guard |
| `PRODUCTION_AUDIT_APPENDIX` resolved-as-open | e.g. `maxParallelAgents` "hardcoded, not configurable" | flagged historical in §5C (it *is* a flag now) | documented, not rewritten (it's a dated audit artifact) |

---

## 7. How to keep everything coherent (the ritual)

Per slice, in order — this is what prevents the next drift:

1. **Investigate** — read `PACKAGES.md` Canonical Homes + grep (`.ts/.tsx/.mts`) before adding anything.
2. **Change minimally**, reuse the canonical home, flag if behavioural.
3. **Update the docs in the same commit** — structural → `PACKAGES.md` (guard checks it); status → §5 here + ROADMAP/NEXT_SESSION; never copy a volatile number.
4. **`pnpm verify` REAL_EXIT_CODE=0** + all 8 guards green.
5. **Sync `memory/`** if it's a durable fact.
6. **Small single-concern commit** on `master`, clean tree, trailer `Co-Authored-By: Claude Opus 4.8`.

The litmus test for "fully makes sense": a new session reading
`MEMORY.md` → `SESSION_HANDOFF` → `PACKAGES.md` → this Contract → `AGENT_OS_BLUEPRINT`
should find **zero contradictions** and a single, current set of numbers. When that
holds and `pnpm verify` is green with 8 guards, the system is as "complete and
consistent" as it can be *proven* to be — and the next gap is always named in §5.
