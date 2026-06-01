# Agent Onboarding & Context Framework

**Audience:** any AI model (or human) picking up AgencyCLI for long-running work.
**Purpose:** load full context fast, work in safe small slices, and hand off without
losing context — token-efficiently. This is the *stable* meta-layer; it points to
the living docs rather than copying them (so it never goes stale or duplicates).

> AgencyCLI is a pnpm monorepo and an **autonomous local agent runtime** (not a
> chatbot), mid production-hardening. Two chronic repo diseases to police on every
> change: **(1) built-but-unwired** machinery and **(2) duplication** (logic / file
> / UI / type / architecture). Three rules that override convenience: *no
> duplication · nothing left dangling · verify, don't assert.*

---

## 1. Read order (the 5-minute load)

Read these, in order, before touching anything. Don't infer from memory — counts
and structure drift; `grep`/read the real file, then conclude.

1. **`memory/MEMORY.md`** — one-line index of cross-session memory; follow the
   linked topic file relevant to your task (root-cause facts marked
   "don't re-investigate" live there).
2. **`docs/ROADMAP_HANDOFF.md` §8** — the live work map. Each item is
   `TRUTH → BUG → FIX(+file)`; ✅ = done (don't redo), 🔴/🟡 = open.
3. **`docs/NEXT_SESSION_PROMPT.md`** — current frontier + the next concrete tasks
   (a point-in-time snapshot; re-confirm with `git log` + `pnpm verify`).
4. **`docs/SESSION_HANDOFF_PROMPT.md`** — the detailed rulebook (anti-dup,
   wired-or-dead, verify, flags, BYOK key safety §6.1).
5. **`docs/PACKAGES.md` → "Canonical Homes & No-Duplication Map"** — who owns what.
   Consult **before** adding any helper / module / tool / command.

For deep dives, use the reference docs via `docs/README.md` (architecture, core
engine, UI, config/state, CLI, security, skills, telemetry).

**Lesson baked in:** when checking for dead code, grep `.ts` **and** `.tsx` **and**
`.mts` (a `.tsx`-only consumer once made live code look dead). Verify-don't-assert
applies to your own audit scripts too (background output can be truncated).

---

## 2. Document taxonomy — one doc per role (this is how dup is prevented)

| Class | Files | Rule |
|-------|-------|------|
| **Reference** (architecture, "what exists") | `README.md`, `ARCHITECTURE.md`, `CORE_ENGINE.md`, `UI_DESIGN.md`, `CONFIG_AND_STATE.md`, `PACKAGES.md`, `CLI_REFERENCE.md`, `DEVELOPMENT.md`, `TESTING.md`, `SECURITY_MODEL.md`, `SKILLS_PACK.md`, `TELEMETRY_BENCHMARK.md`, `TUI-UX-HANDOVER.md`, `UI_DESIGN.md` | Keep accurate when you change the thing they describe. Avoid hard-coding volatile counts — prefer "run `pnpm verify` / `agency status`". |
| **Living / process** (the work + the rules) | `ROADMAP_HANDOFF.md` (work map), `HARDENING_HANDOFF.md` (campaign status + `cont'd N` log), `SESSION_HANDOFF_PROMPT.md` (rules + paste-in prompt), `NEXT_SESSION_PROMPT.md` (next-session paste-in), `EVAL_RESULTS.md` (eval log) | Update in the **same slice** as the change. Append to logs; don't rewrite history. |
| **Frozen** (point-in-time audits) | `PRODUCTION_AUDIT.md`, `PRODUCTION_AUDIT_APPENDIX.md` | **Do not edit.** Historical record. |
| **Framework** (this doc) | `AGENT_ONBOARDING.md` | Stable. Edit only when the *method* changes, not for routine work. |

Before creating any new doc, find the role above — extend the existing owner
instead of adding a parallel file. The same applies in code: there is exactly one
canonical home per concern (see `PACKAGES.md`).

---

## 3. Memory model (two tiers, kept small)

Cross-session memory lives in `memory/` (outside the repo, per-project):

- **`MEMORY.md` — the index.** One line per memory, ≤ ~200 chars, a pointer +
  hook. **Never inline detail here** — that is what overflows it and stops it
  from fully loading. If a line is growing into a paragraph, the detail belongs
  in a topic file.
- **Topic files — the detail.** One file per durable theme (e.g. a campaign).
  Hold root-cause findings, the git chain, "don't re-investigate" facts. Loaded
  on demand (only when relevant), so size matters less than for the index.

Token rules: prune stale facts; merge duplicates; convert relative dates to
absolute; link related memories with `[[topic-name]]`. When the index nears its
size limit, migrate the heaviest detail *down* into topic files and re-collapse
the index lines (see template §6.1). The `consolidate-memory` skill automates a
reflective pass.

Don't store what the repo already records (code structure, past fixes, git
history, CLAUDE.md). Store what was *non-obvious*: a root cause, a deliberate
trade-off, a constraint not derivable from the code.

---

## 4. Session-tracking rhythm (one slice = one commit)

Repeat per change. Small, single-concern, behavior-preserving.

```
investigate  → read + grep (.ts/.tsx/.mts), consult Canonical Homes
classify     → real-dup vs intentional-distinct · wire vs delete
change       → minimal, reuse the canonical home, behavior-preserving
flag         → if behavior changes: add to runtime/flags.ts (legacy byte-identical);
               purely additive (new tool/command) needs no flag
test         → add/extend tests next to the change
verify       → pnpm verify  →  REAL_EXIT_CODE=0  (no asserting green)
commit       → small, on master, clean tree, no amend / no --no-verify
sync         → update living docs + memory (index line + topic file) in this slice
guards       → keep all 6 regression guards green (§5)
```

---

## 5. Non-negotiables

- **Verify, don't assert.** `pnpm verify` (= `pnpm -r build && pnpm -r test`) must
  exit 0 before you say "green" or commit. This repo has a history of false-green
  handoffs. Ignore only the known-intentional warnings (failover / rate-limit /
  Playwright-missing / docker-unreachable).
- **No duplication.** Consult Canonical Homes first; reuse, don't re-implement.
  Some same-named pairs are *intentionally distinct* — don't merge them (listed in
  `PACKAGES.md` / `SESSION_HANDOFF_PROMPT.md` §1).
- **Nothing dangling.** New machinery must be wired and used now, or not added.
  Distinguish *dead-true* (delete) from *live-consumer/dead-producer* (wire).
- **Flag behavior changes** behind `runtime/flags.ts` (`AGENCY_PROFILE=legacy|hardened`;
  legacy = byte-identical old behavior). Don't auto-promote hardened→default — that
  needs a clean eval delta **and** explicit user OK.
- **6 regression guards** run inside `pnpm verify` — keep them green; when you add a
  skill/agent/flag/dep/tool, update its registry **in the same slice**:
  skills↔manifest · agents↔prompt/seed · flags↔status · module-cycles ·
  package-cycles · deps↔imports hygiene.
- **BYOK key safety.** API keys live in env only, never on disk/docs. Follow
  `SESSION_HANDOFF_PROMPT.md` §6.1 (backup config, `${VAR}` placeholder, restore in
  the same command, confirm `grep` for key prefixes is empty afterward).
- **Sandbox stays usable.** The native egress sandbox must not block reputable dev
  hosts (Google Fonts, package registries, provider APIs). Whitelist lives in
  `packages/security/src/egress-proxy.ts`; widen narrowly and specifically.

---

## 6. Templates (copy, fill, delete the comments)

### 6.1 Memory — index line (`MEMORY.md`)
```markdown
- [<Title>](<topic-slug>.md) — <one-line hook: scope · what's DONE · what's OPEN · latest commit>. <"holds X facts" if it's a root-cause store>.
```

### 6.2 Memory — topic file header
```markdown
---
name: <topic-slug>
description: <one-line summary used for recall relevance>
metadata:
  type: project        # user | feedback | project | reference
---

<theme>. Root-cause facts marked "don't re-investigate". Git chain at the bottom.
Link related memories with [[other-slug]].
```

### 6.3 Session handoff (paste into the next session / `NEXT_SESSION_PROMPT.md`)
```markdown
You take over AgencyCLI (D:\AgencyCLI). READ FIRST (in order):
docs/AGENT_ONBOARDING.md → memory/MEMORY.md → docs/ROADMAP_HANDOFF.md §8 →
docs/NEXT_SESSION_PROMPT.md → docs/PACKAGES.md "Canonical Homes".

DONE (HEAD <hash>, master, clean — don't redo): <one line per closed item>.
NEXT (verify without key, priority): <task A> → <task B>.
NEEDS BYOK key: <task> (why).
RHYTHM: §4 of AGENT_ONBOARDING. Keep the 6 guards green. Don't auto-promote
hardened→default. First: remind me to `pnpm -r build` + restart TUI if src changed.
```

### 6.4 Commit message
```
<type>(<pkg>): <imperative summary>

<what + why; the root cause if a fix; the trade-off if a choice>
Tests: <what was added>. pnpm verify REAL_EXIT_CODE=0, <counts before→after>.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
```

### 6.5 Adding a flag / tool / skill / agent / dep (guard checklist)
```
flag  → runtime/flags.ts + surface in `agency status` (buildFlagRows) + a test
tool  → register in the single ToolRegistry (auto-advertised) + tests; gate only if it changes existing behavior
skill → manifest + on-disk SKILL.md (skills↔manifest guard)
agent → prompt-map + capability seed + MANIFEST_AGENTS (agents↔prompt/seed guard)
dep   → package.json must match real imports (deps↔imports guard); verify it adds no package cycle
```

---

## 7. Reporting outcomes faithfully

State what actually happened. If tests fail, show the output. If a step was
skipped, say so. When something is done and verified, say it plainly. A finding
you can't fix now: record it as a one-liner (a "Follow-ups noted" entry in the
relevant topic file or ROADMAP), don't bury it.
