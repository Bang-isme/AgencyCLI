# AgencyCLI Eval Results — `agency eval --agent`

> Living record of real agent-backed eval runs. Methodology + how to reproduce, then
> the measured legacy↔hardened comparison. Companion to
> [HARDENING_HANDOFF.md](HARDENING_HANDOFF.md) (§5 verify-loop) and the eval harness in
> `packages/benchmark`. Last run: 2026-05-31 (provider: NVIDIA NIM `minimaxai/minimax-m2.7`).

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
| `hard` | `hard-slugify`, `hard-parse-duration`, `hard-roman-numeral` (multi-file), `hard-csv-parse` |

Each hard task's `test.cjs` prints its failing case(s) to stderr so self-correction has a
concrete signal. `hard-csv-parse` (added 2026-05-31) is the sharpest intended discriminator:
quoted commas, the `""`→`"` escape, and a trailing empty field — classic round-1 near-misses.

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

- Grow the corpus with tasks **harder than this model can one-shot** (subtle multi-file refactors,
  obscure-spec parsers, concurrency edge cases) so `avg rounds > 1` under hardened and the
  self-correction delta becomes measurable.
- Or run the comparison against a **smaller/weaker model** where near-misses are common — that is
  where the verify-loop's value (legacy fails → hardened self-corrects → passes) will show.
- Commit a baseline to a non-gitignored path + wire `agency eval` into CI as a regression gate.
