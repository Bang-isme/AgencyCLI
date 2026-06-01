# AgencyCLI Eval Results — `agency eval --agent`

> Living record of real agent-backed eval runs. Methodology + how to reproduce, then
> the measured legacy↔hardened comparison. Companion to
> [HARDENING_HANDOFF.md](HARDENING_HANDOFF.md) (§5 verify-loop) and the eval harness in
> `packages/benchmark`. Last run: 2026-06-01 (provider: NVIDIA NIM `minimaxai/minimax-m2.7`).

---

## What the eval measures

`agency eval --agent` runs each corpus task end-to-end in an **isolated workspace**:
`setup` (write a broken/incomplete starting state) → `execute` (the real agent attempt via
`runChatTurnWithStream`) → `validate` (the task's own acceptance test, `node test.cjs`).

The crux (closed 2026-05-31): the attempt is wrapped in the **real `runVerifyLoop`** with
**acceptance == the task's acceptance test**, so "loop passed" ⇔ "task passes". The two
profiles differ only in self-correction:

- **legacy** (`verifyLoop` off) → `maxRounds = 1` → a single one-shot attempt.
- **hardened** (`verifyLoop` on) → up to `verifyMaxRounds` (3) attempts; on a failing round
  the failing test output is fed back into the next turn so a near-miss can self-correct.

Headline metric = **task success rate** (did the agent actually fix it?), not "tests pass".

## Corpus

| Suite | Tasks |
|---|---|
| `easy` | `fix-add-bug`, `impl-multiply`, `fix-clamp-bug` |
| `hard` | `hard-slugify`, `hard-parse-duration`, `hard-roman-numeral` (multi-file), `hard-csv-parse`, `hard-merge-intervals` |

Each hard task's `test.cjs` prints its failing case(s) to stderr so self-correction has a
concrete signal. `hard-merge-intervals` (added 2026-06-01) is the sharpest discriminator: it is
**counter-conventional** — overlapping intervals merge, but ones that merely *touch* (share an
endpoint) must NOT (correct impl needs a strict `<`; the universal `<=` fails exactly the touch
cases). Overriding that training prior is what trips a strong model's first attempt.

## Reproduce

```bash
export NVIDIA_API_KEY=...           # key stays in env only; never write it to config.json
# config.json points provider "nvidia" at apiKey "${NVIDIA_API_KEY}", model minimaxai/minimax-m2.7

AGENCY_PROFILE=legacy   agency eval --agent --suite hard --provider nvidia \
  --baseline .agency/eval-baseline-hard.json --update-baseline
AGENCY_PROFILE=hardened agency eval --agent --suite hard --provider nvidia \
  --baseline .agency/eval-baseline-hard.json        # gates hardened vs the legacy baseline
```

`.agency/` is gitignored, so the baseline + run JSON are local artifacts. To gate in CI, write
the baseline somewhere non-ignored or regenerate it in the pipeline.

---

## Results — 2026-06-01, `minimaxai/minimax-m2.7` (NVIDIA NIM) — verify-loop fires end-to-end

Added the counter-conventional `hard-merge-intervals` discriminator (see Corpus) and re-ran the
full legacy↔hardened comparison.

### Hard suite (5 tasks)

| Profile | Pass | Success | avg rounds | `hard-merge-intervals` | Gate |
|---|---|---|---|---|---|
| legacy   | 5/5 | 100% | 1.0 | rounds=1 (one-shot this run) | baseline |
| hardened | 5/5 | 100% | 1.2 | **rounds=2 — attempt 1 failed acceptance → fed back → attempt 2 passed** | **PASS** |

**First end-to-end evidence the production verify-loop self-heals a real model mistake.** In the
hardened run, `hard-merge-intervals` recorded **rounds=2**: the first attempt failed the
acceptance test (the touch cases), the failing `test.cjs` output was fed back into the next turn,
and the second attempt passed. Every prior run only ever showed avg rounds = 1.0 — the loop never
had a failing round to fire on. This complements the mocked integration tests
(`agents-orchestrator.test.ts`, `main-turn-verify.test.ts`) with a **live-model** demonstration.

Why the success *rate* is still equal (both 5/5), not legacy<hardened: the loop *recovered* the
failure, and the model is non-deterministic — it one-shot the same task in the legacy run. The
**rounds telemetry**, not the rate, is the proof here. A clean rate gap needs a task this model
fails attempt-1 *reliably* (or a weaker model); `hard-merge-intervals` sits right at minimax's
attempt-1 boundary, which is exactly why it fired the loop at all.

---

## Results — 2026-05-31, `minimaxai/minimax-m2.7` (NVIDIA NIM)

### Hard suite (4 tasks)

| Profile | Pass | Success rate | avg rounds | avg cost/task | Gate |
|---|---|---|---|---|---|
| legacy   | 4/4 | 100% | 1.0 | $0.0106 | baseline |
| hardened | 4/4 | 100% | 1.0 | $0.0120 | **PASS** (Δ +0.0%, no regression) |

### Easy suite (3 tasks, legacy)

`fix-add-bug` ✓, `fix-clamp-bug` ✓, `impl-multiply` ✗ — the one failure was a **transient
NVIDIA infra error** (`instance_id ... not found for endpoint dynamo/backend/generate`,
rounds=0/cost=0: the request itself failed before the agent could attempt), not a coding miss.

---

## Findings

1. **The harness works end-to-end on a real model.** The agent autonomously edited code in an
   isolated workspace and passed the real acceptance tests — provider → routing → tool calls →
   file edits → verify all wired correctly.
2. **Hardened never regresses legacy.** Same 4/4, gate PASS. The verify-loop wrapping is
   behaviour-safe.
3. **Ceiling effect — the corpus can't yet measure self-correction with this model.**
   `minimax-m2.7` one-shots every task (avg rounds = 1.0 in *both* profiles, even
   `hard-csv-parse`), so the verify-loop never has a failing round to repair. The loop's
   self-correction is proven by the integration tests (`agents-orchestrator.test.ts`,
   `main-turn-verify.test.ts` — mocked re-run on failure); demonstrating it **end-to-end** needs
   a task at *this* model's failure boundary (or a weaker model).
4. **Robustness under rate limits.** The hardened run was heavily throttled by the NVIDIA free
   tier ("Adapted RPM: 2–4", many retries) yet still completed 4/4 — the provider rate-limiter's
   adaptive backoff/retry kept it alive instead of failing the tasks.

## Recommended next steps

- ✅ **Done (2026-06-01):** added `hard-merge-intervals`, a discriminator at this model's
  attempt-1 boundary → the hardened verify-loop fired end-to-end (rounds=2 self-heal). The loop is
  now demonstrated on a live model, not just in mocked tests.
- **For a clean success-*rate* delta** (legacy<hardened), the corpus still needs a task this model
  fails attempt-1 *reliably* (merge-intervals is non-deterministic at the boundary), or a run
  against a **smaller/weaker model** where near-misses are the norm. Candidate harder tasks:
  subtle multi-file refactors, more counter-conventional specs, concurrency/ordering edge cases.
- Commit a baseline to a non-gitignored path + wire `agency eval` into CI as a regression gate.
